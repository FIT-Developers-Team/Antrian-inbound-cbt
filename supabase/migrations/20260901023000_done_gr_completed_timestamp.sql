begin;

alter table public.tickets
  add column if not exists completed_at timestamptz;

create or replace function public.complete_ticket_on_all_done_gr()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if upper(coalesce(new.gr_status, '')) <> 'DONE GR' then
    return new;
  end if;

  if not exists (
    select 1
    from public.ticket_pos
    where ticket_id = new.ticket_id
      and upper(coalesce(gr_status, '')) <> 'DONE GR'
  ) then
    update public.tickets
    set status = 'COMPLETED',
        done_unloading_at = coalesce(done_unloading_at, new.gr_done_at, now()),
        completed_at = coalesce(completed_at, new.gr_done_at, now())
    where ticket_id = new.ticket_id
      and status not in ('COMPLETED', 'EXPIRED');

    if found then
      insert into public.ticket_events(
        ticket_id,
        event_type,
        actor_role,
        actor_name,
        payload_json
      ) values (
        new.ticket_id,
        'STATUS_COMPLETED_BY_DONE_GR',
        'SYSTEM',
        'DONE GR',
        jsonb_build_object('ticket_po_id', new.ticket_po_id)
      );
    end if;
  end if;

  return new;
end;
$$;

update public.tickets t
set completed_at = coalesce(
      (
        select max(p.gr_done_at)
        from public.ticket_pos p
        where p.ticket_id = t.ticket_id
      ),
      t.completed_at,
      now()
    ),
    done_unloading_at = coalesce(
      t.done_unloading_at,
      (
        select max(p.gr_done_at)
        from public.ticket_pos p
        where p.ticket_id = t.ticket_id
      ),
      now()
    )
where t.status = 'COMPLETED'
  and exists (
    select 1
    from public.ticket_pos p
    where p.ticket_id = t.ticket_id
  )
  and not exists (
    select 1
    from public.ticket_pos p
    where p.ticket_id = t.ticket_id
      and upper(coalesce(p.gr_status, '')) <> 'DONE GR'
  );

commit;
