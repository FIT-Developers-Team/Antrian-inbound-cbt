begin;

alter table public.tickets
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_reason text,
  add column if not exists cancelled_by text;
alter table public.ticket_pos
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_reason text,
  add column if not exists cancelled_by text;

create or replace view public.inbound_operational_rows
with (security_invoker = true) as
select
  t.ticket_id, t.queue_no, t.ticket_type, t.status, t.vendor_name,
  t.fleet_type, t.plat_number, t.driver_name, t.driver_phone as phone_number,
  t.gate, t.slot, t.operational_date::text as operational_date,
  t.registered_by, t.ktp_6_digit, t.unload_sla, t.source,
  t.called_at, t.arrived_at, t.start_unloading_at,
  t.done_unloading_at as finish_unloading_at, t.expired_at, t.expired_reason,
  t.call_count, t.last_call_at, t.created_at as register_time,
  t.created_at, t.updated_at,
  p.ticket_po_id, p.po_number, p.vendor_name as po_vendor_name,
  p.request_quantity as total_po_qty, p.actual_quantity,
  p.count_sku as count_po_sku, p.checker_status, p.gr_status,
  p.checker_id, p.checker_name,
  p.checking_started_at as checker_started_at,
  p.checking_done_at as checker_done_at,
  p.gr_done_at as done_gr_at, p.handover_grn_at,
  p.created_at as po_created_at, p.updated_at as po_updated_at,
  greatest(t.updated_at, coalesce(p.updated_at, t.updated_at)) as row_updated_at,
  row_number() over (partition by t.ticket_id order by p.created_at, p.ticket_po_id) as po_sequence,
  count(p.ticket_po_id) over (partition by t.ticket_id) as ticket_po_count,
  coalesce(sum(p.request_quantity) filter (where p.cancelled_at is null) over (partition by t.ticket_id), 0) as ticket_total_qty,
  coalesce(sum(p.count_sku) filter (where p.cancelled_at is null) over (partition by t.ticket_id), 0) as ticket_total_sku,
  max(p.gr_done_at) over (partition by t.ticket_id) as ticket_done_gr_at,
  count(*) filter (where upper(coalesce(p.gr_status, '')) = 'DONE GR') over (partition by t.ticket_id)
    = count(*) filter (where p.cancelled_at is null) over (partition by t.ticket_id)
    and count(*) filter (where p.cancelled_at is null) over (partition by t.ticket_id) > 0 as ticket_all_done_gr,
  t.tkbm_count, t.completed_at,
  t.cancelled_at, t.cancelled_reason, t.cancelled_by,
  p.cancelled_at as po_cancelled_at, p.cancelled_reason as po_cancelled_reason,
  p.cancelled_by as po_cancelled_by
from public.tickets t
left join public.ticket_pos p on p.ticket_id = t.ticket_id;

-- All operational actions serialize on the parent ticket, including cancellation.
alter function public.inbound_update_ticket_pos(text,jsonb,jsonb) rename to inbound_update_ticket_pos_before_cancel;
alter function public.inbound_update_ticket_status(jsonb,jsonb) rename to inbound_update_ticket_status_before_cancel;
revoke all on function public.inbound_update_ticket_pos_before_cancel(text,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.inbound_update_ticket_status_before_cancel(jsonb,jsonb) from public, anon, authenticated, service_role;

create or replace function public.inbound_update_ticket_pos(p_action text,p_payload jsonb,p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_status text; v_po_ids text[]; v_result jsonb;
begin
  select status into v_status from public.tickets where ticket_id=p_payload->>'ticket_id' for update;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if v_status='CANCELLED' then raise exception 'Tiket sudah dibatalkan.'; end if;
  if upper(coalesce(p_payload->>'status',''))='CANCELLED' then raise exception 'Gunakan aksi pembatalan dengan alasan.'; end if;
  select array_agg(value) into v_po_ids from (
    select jsonb_array_elements_text(coalesce(p_payload->'ticket_po_ids','[]'::jsonb)) as value
    union select p_payload->>'ticket_po_id'
    union select value->>'ticket_po_id' from jsonb_array_elements(coalesce(p_payload->'items','[]'::jsonb))
  ) ids;
  if exists(select 1 from public.ticket_pos where ticket_id=p_payload->>'ticket_id'
    and ticket_po_id=any(v_po_ids) and cancelled_at is not null) then
    raise exception 'PO sudah dibatalkan. Refresh data dahulu.';
  end if;
  v_result:=public.inbound_update_ticket_pos_before_cancel(p_action,p_payload,p_actor);
  if lower(p_action)='donecheckerpo' then
    update public.tickets set status='WAITING GR',done_unloading_at=coalesce(done_unloading_at,now())
    where ticket_id=p_payload->>'ticket_id' and status='UNLOADING'
      and not exists(select 1 from public.ticket_pos where ticket_id=p_payload->>'ticket_id'
        and cancelled_at is null and checker_status not in ('DONE','SKIPPED'));
    select jsonb_build_object('rows',jsonb_agg(to_jsonb(r))) into v_result
      from public.inbound_operational_rows r where ticket_id=p_payload->>'ticket_id';
  end if;
  return v_result;
end; $$;

create or replace function public.inbound_update_ticket_status(p_payload jsonb,p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_status text;
begin
  select status into v_status from public.tickets where ticket_id=p_payload->>'ticket_id' for update;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if v_status='CANCELLED' then raise exception 'Tiket sudah dibatalkan.'; end if;
  if upper(coalesce(p_payload->>'status',''))='CANCELLED' then raise exception 'Gunakan aksi pembatalan dengan alasan.'; end if;
  return public.inbound_update_ticket_status_before_cancel(p_payload,p_actor);
end; $$;

-- Cancelled POs are excluded from GR completion, never converted into DONE GR.
create or replace function public.complete_ticket_on_all_done_gr()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if upper(coalesce(new.gr_status,'')) not in ('DONE GR','CANCELLED') then return new; end if;
  perform 1 from public.tickets where ticket_id=new.ticket_id for update;
  if exists(select 1 from public.ticket_pos where ticket_id=new.ticket_id and cancelled_at is null)
    and not exists(select 1 from public.ticket_pos where ticket_id=new.ticket_id
      and cancelled_at is null and upper(coalesce(gr_status,''))<>'DONE GR') then
    update public.tickets set status='COMPLETED',
      completed_at=coalesce(completed_at,(select max(gr_done_at) from public.ticket_pos where ticket_id=new.ticket_id and cancelled_at is null),now()),
      done_unloading_at=coalesce(done_unloading_at,(select max(gr_done_at) from public.ticket_pos where ticket_id=new.ticket_id and cancelled_at is null),now())
    where ticket_id=new.ticket_id and status not in ('COMPLETED','EXPIRED','CANCELLED');
    if found then
      insert into public.ticket_events(ticket_id,event_type,actor_role,actor_name,payload_json)
      values(new.ticket_id,'STATUS_COMPLETED_BY_DONE_GR','SYSTEM','DONE GR',jsonb_build_object('ticket_po_id',new.ticket_po_id));
    end if;
  end if;
  return new;
end; $$;

create or replace function public.inbound_cancel(p_payload jsonb,p_actor jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_id text:=nullif(btrim(p_payload->>'ticket_id'),'');
  v_po text:=nullif(btrim(p_payload->>'ticket_po_id'),'');
  v_reason text:=nullif(btrim(p_payload->>'reason'),'');
  v_ticket public.tickets;
  v_rows jsonb;
  v_cancelled_at timestamptz:=now();
begin
  if coalesce(p_actor->>'role','') not in ('SPV','ADMIN','DEVELOPER') then raise exception 'Akses pembatalan ditolak.'; end if;
  if v_id is null or v_reason is null or length(v_reason)>500 then raise exception 'Ticket dan alasan pembatalan (1-500 karakter) wajib diisi.'; end if;
  select * into v_ticket from public.tickets where ticket_id=v_id for update;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if v_po is not null and not exists(select 1 from public.ticket_pos where ticket_id=v_id and ticket_po_id=v_po) then
    raise exception 'PO tidak ditemukan pada tiket ini.';
  end if;
  -- Repeated clicks/retries do not alter original reason/time or add duplicate events.
  if v_ticket.status='CANCELLED' or (v_po is not null and exists(
    select 1 from public.ticket_pos where ticket_id=v_id and ticket_po_id=v_po and cancelled_at is not null)) then
    select jsonb_agg(to_jsonb(r)) into v_rows from public.inbound_operational_rows r where ticket_id=v_id;
    return jsonb_build_object('rows',coalesce(v_rows,'[]'::jsonb),'already_cancelled',true);
  end if;
  if v_ticket.status in ('COMPLETED','DONE GR','EXPIRED') then raise exception 'Tiket terminal tidak dapat dibatalkan.'; end if;
  if exists(select 1 from public.ticket_pos where ticket_id=v_id and (v_po is null or ticket_po_id=v_po)
    and upper(gr_status)='DONE GR') then
    raise exception 'PO sudah Done GR tidak bisa dibatalkan. Pilih hanya PO yang belum Done GR.';
  end if;

  update public.ticket_pos set cancelled_at=v_cancelled_at,cancelled_reason=v_reason,cancelled_by=p_actor->>'name',
    checker_status='CANCELLED',gr_status='CANCELLED'
  where ticket_id=v_id and (v_po is null or ticket_po_id=v_po) and cancelled_at is null;

  if not exists(select 1 from public.ticket_pos where ticket_id=v_id and cancelled_at is null) then
    update public.tickets set status='CANCELLED',cancelled_at=v_cancelled_at,
      cancelled_reason=v_reason,cancelled_by=p_actor->>'name',completed_at=null
    where ticket_id=v_id;
    update public.gates set status='KOSONG',ticket_id=null where ticket_id=v_id;
  else
    -- Advance the remaining completed checks even when the last pending PO is cancelled.
    update public.tickets set status='WAITING GR',done_unloading_at=coalesce(done_unloading_at,now())
    where ticket_id=v_id and status='UNLOADING'
      and not exists(select 1 from public.ticket_pos where ticket_id=v_id and cancelled_at is null and checker_status not in ('DONE','SKIPPED'));
    update public.tickets set updated_at=now() where ticket_id=v_id;
  end if;
  insert into public.ticket_events(ticket_id,event_type,actor_role,actor_name,payload_json)
  values(v_id,case when v_po is null then 'TICKET_CANCELLED' else 'PO_CANCELLED' end,
    p_actor->>'role',p_actor->>'name',jsonb_build_object('ticket_po_id',v_po,'reason',v_reason,'cancelled_at',v_cancelled_at));
  select jsonb_agg(to_jsonb(r) order by po_sequence) into v_rows from public.inbound_operational_rows r where ticket_id=v_id;
  return jsonb_build_object('rows',coalesce(v_rows,'[]'::jsonb));
end; $$;

-- A stale client or older bulk operation cannot revive a cancelled entity.
create or replace function public.guard_cancelled_entity()
returns trigger language plpgsql set search_path=public as $$
begin
  if old.cancelled_at is not null and (
    (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at')
  ) then raise exception 'Data yang dibatalkan tidak dapat diproses lagi.'; end if;
  return new;
end; $$;
create trigger tickets_guard_cancelled before update on public.tickets
for each row execute function public.guard_cancelled_entity();
create trigger ticket_pos_guard_cancelled before update on public.ticket_pos
for each row execute function public.guard_cancelled_entity();

-- Clear Task excludes cancelled tickets and POs and locks parents in a stable order.
create or replace function public.inbound_bulk_complete_operational(p_payload jsonb,p_actor jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_date date:=coalesce((p_payload->>'operational_date')::date,(timezone('Asia/Jakarta',now())-interval '4 hours')::date);
  v_all boolean:=coalesce((p_payload->>'all_active')::boolean,false); v_ids text[]; v_pos integer; v_tickets integer;
begin
  if coalesce(p_actor->>'role','')<>'DEVELOPER' then raise exception 'Developer only.'; end if;
  select coalesce(array_agg(ticket_id),array[]::text[]) into v_ids from (
    select ticket_id from public.tickets
    where upper(coalesce(status,'WAITING')) not in('COMPLETED','EXPIRED','CANCELLED')
      and (v_all or operational_date=v_date) order by ticket_id for update
  ) locked;
  if cardinality(v_ids)=0 then return jsonb_build_object('tickets_completed',0,'po_completed',0); end if;
  update public.ticket_pos set checker_id=coalesce(nullif(checker_id,''),p_actor->>'name'),checker_name=coalesce(nullif(checker_name,''),p_actor->>'name'),
    checker_status='DONE',checking_started_at=coalesce(checking_started_at,now()),checking_done_at=coalesce(checking_done_at,now()),
    actual_quantity=case when coalesce(actual_quantity,0)<=0 then coalesce(request_quantity,0) else actual_quantity end,
    gr_status='DONE GR',gr_done_at=coalesce(gr_done_at,now())
    where ticket_id=any(v_ids) and cancelled_at is null;
  get diagnostics v_pos=row_count;
  update public.tickets set status='COMPLETED',completed_at=coalesce(completed_at,now()),
    called_at=coalesce(called_at,now()),start_unloading_at=coalesce(start_unloading_at,now()),
    done_unloading_at=coalesce(done_unloading_at,now())
    where ticket_id=any(v_ids) and status<>'CANCELLED';
  get diagnostics v_tickets=row_count;
  insert into public.ticket_events(ticket_id,event_type,actor_role,actor_name,payload_json)
    select unnest(v_ids),'DEVELOPER_BULK_COMPLETE',p_actor->>'role',p_actor->>'name',jsonb_build_object('operational_date',v_date::text,'all_active',v_all);
  return jsonb_build_object('operational_date',v_date::text,'all_active',v_all,'tickets_completed',v_tickets,'po_completed',v_pos);
end; $$;

revoke all on function public.inbound_cancel(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.inbound_bulk_complete_operational(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.inbound_update_ticket_pos(text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.inbound_update_ticket_status(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.inbound_cancel(jsonb,jsonb) to service_role;
grant execute on function public.inbound_update_ticket_pos(text,jsonb,jsonb) to service_role;
grant execute on function public.inbound_update_ticket_status(jsonb,jsonb) to service_role;
commit;
