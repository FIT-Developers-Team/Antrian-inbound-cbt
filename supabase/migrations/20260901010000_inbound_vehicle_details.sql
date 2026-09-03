begin;

alter table public.tickets add column if not exists tkbm_count integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tickets_tkbm_count_nonnegative'
      and conrelid = 'public.tickets'::regclass
  ) then
    alter table public.tickets
      add constraint tickets_tkbm_count_nonnegative check (tkbm_count >= 0);
  end if;
end;
$$;

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
  coalesce(sum(p.request_quantity) over (partition by t.ticket_id), 0) as ticket_total_qty,
  coalesce(sum(p.count_sku) over (partition by t.ticket_id), 0) as ticket_total_sku,
  max(p.gr_done_at) over (partition by t.ticket_id) as ticket_done_gr_at,
  count(*) filter (where upper(coalesce(p.gr_status, '')) = 'DONE GR') over (partition by t.ticket_id)
    = count(*) over (partition by t.ticket_id) as ticket_all_done_gr,
  t.tkbm_count
from public.tickets t
left join public.ticket_pos p on p.ticket_id = t.ticket_id;

create or replace view public.inbound_ticket_summaries
with (security_invoker = true) as
select t.ticket_id, t.queue_no, t.ticket_type, t.status, t.vendor_name,
  t.fleet_type, t.plat_number, t.driver_name, t.driver_phone, t.gate, t.slot,
  t.operational_date::text as operational_date, t.registered_by, t.called_at,
  t.arrived_at, t.start_unloading_at, t.done_unloading_at, t.expired_at,
  t.created_at, t.updated_at,
  coalesce(sum(p.request_quantity), 0) as request_quantity,
  coalesce(sum(p.actual_quantity), 0) as actual_quantity,
  count(p.ticket_po_id) as po_count, t.tkbm_count
from public.tickets t left join public.ticket_pos p on p.ticket_id = t.ticket_id
group by t.ticket_id;

create or replace function public.inbound_create_tickets_bulk(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_items jsonb := coalesce(p_payload->'tickets', '[]'::jsonb);
  v_item jsonb; v_ticket jsonb; v_po jsonb;
  v_ticket_id text; v_ticket_type text; v_slot text; v_queue_no text;
  v_operational_date date := (timezone('Asia/Jakarta', now()) - interval '4 hours')::date;
  v_seq integer; v_created jsonb := '[]'::jsonb; v_po_id text;
begin
  if jsonb_array_length(v_items) < 1 then raise exception 'Minimal satu ticket wajib diisi.'; end if;
  if jsonb_array_length(v_items) > 50 then raise exception 'Maksimal 50 ticket per submit.'; end if;

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_ticket := coalesce(v_item->'ticket', v_item);
    v_ticket_id := coalesce(nullif(btrim(v_ticket->>'ticket_id'), ''), gen_random_uuid()::text);
    if exists(select 1 from public.tickets where ticket_id = v_ticket_id) then
      raise exception 'ticket_id duplikat: %', v_ticket_id;
    end if;
    if jsonb_array_length(coalesce(v_item->'pos', '[]'::jsonb)) < 1 then
      raise exception 'Minimal satu PO wajib diisi.';
    end if;
    v_ticket_type := upper(regexp_replace(coalesce(nullif(btrim(v_ticket->>'ticket_type'), ''), 'REG'), '\s+', '-', 'g'));
    if v_ticket_type = 'DROP' then v_ticket_type := 'DROP-OFF'; end if;
    v_slot := coalesce(nullif(btrim(v_ticket->>'slot'), ''), '3');
    perform pg_advisory_xact_lock(hashtext(v_operational_date::text || '|' || v_ticket_type || '|' || v_slot));
    select coalesce(max((regexp_match(queue_no, '(\d+)\s*$'))[1]::integer), 0) + 1 into v_seq
      from public.tickets where operational_date = v_operational_date
      and ticket_type = v_ticket_type and slot = v_slot;
    v_queue_no := v_ticket_type || ' ' || v_slot || '-' || v_seq;

    insert into public.tickets(ticket_id, queue_no, ticket_type, status, vendor_name,
      fleet_type, plat_number, driver_name, driver_phone, gate, slot, operational_date,
      registered_by, ktp_6_digit, unload_sla, source, tkbm_count)
    values(v_ticket_id, v_queue_no, v_ticket_type,
      coalesce(nullif(btrim(v_ticket->>'status'), ''), 'WAITING'), nullif(btrim(v_ticket->>'vendor_name'), ''),
      nullif(btrim(v_ticket->>'fleet_type'), ''), nullif(btrim(v_ticket->>'plat_number'), ''),
      nullif(btrim(v_ticket->>'driver_name'), ''), nullif(btrim(v_ticket->>'driver_phone'), ''),
      nullif(btrim(v_ticket->>'gate'), ''), v_slot, v_operational_date,
      nullif(btrim(v_ticket->>'registered_by'), ''), nullif(btrim(v_ticket->>'ktp_6_digit'), ''),
      coalesce(nullif(btrim(v_ticket->>'unload_sla'), ''), 'ON PROCESS'),
      coalesce(nullif(btrim(v_ticket->>'source'), ''), 'Supabase'),
      greatest(coalesce((v_ticket->>'tkbm_count')::integer, 0), 0));

    for v_po in select value from jsonb_array_elements(v_item->'pos')
    loop
      if nullif(btrim(v_po->>'po_number'), '') is null then raise exception 'po_number wajib diisi.'; end if;
      if coalesce((v_po->>'is_manual')::boolean, false) = false and not exists(
        select 1 from public.superset_po_master where po_number = btrim(v_po->>'po_number')) then
        raise exception 'PO % tidak ditemukan di master Supabase. Pilih opsi PO manual.', btrim(v_po->>'po_number');
      end if;
      v_po_id := coalesce(nullif(btrim(v_po->>'ticket_po_id'), ''), gen_random_uuid()::text);
      insert into public.ticket_pos(ticket_po_id, ticket_id, po_number, vendor_name,
        request_quantity, actual_quantity, count_sku, checker_status)
      values(v_po_id, v_ticket_id, btrim(v_po->>'po_number'),
        coalesce(nullif(btrim(v_po->>'vendor_name'), ''), nullif(btrim(v_ticket->>'vendor_name'), '')),
        coalesce((v_po->>'request_quantity')::double precision, 0),
        coalesce((v_po->>'actual_quantity')::double precision, 0),
        coalesce((v_po->>'count_sku')::integer, 0),
        coalesce(nullif(btrim(v_po->>'checker_status'), ''), 'PENDING'));
      insert into public.gsheet_sync_outbox(ticket_po_id, ticket_id)
      values(v_po_id, v_ticket_id) on conflict (ticket_po_id) do update set
        ticket_id=excluded.ticket_id, sync_status='PENDING', attempt_count=0,
        last_error=null, synced_at=null, updated_at=now();
    end loop;
    insert into public.ticket_events(ticket_id,event_type,actor_role,actor_name,payload_json)
      values(v_ticket_id,'SECURITY_REGISTERED',p_actor->>'role',p_actor->>'name',
        jsonb_build_object('queue_no',v_queue_no,'po_count',jsonb_array_length(v_item->'pos'),'tkbm_count',greatest(coalesce((v_ticket->>'tkbm_count')::integer,0),0)));
    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'ticket_id',v_ticket_id,'queue_no',v_queue_no,'operational_date',v_operational_date::text));
  end loop;
  return jsonb_build_object('created',v_created,'inserted_tickets',jsonb_array_length(v_created));
end;
$$;

grant execute on function public.inbound_create_tickets_bulk(jsonb,jsonb) to service_role;

commit;
