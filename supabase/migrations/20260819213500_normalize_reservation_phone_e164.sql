create or replace function public.normalize_reservation_phone_e164(
  p_phone text,
  p_default_country_calling_code text default '+34'
)
returns text
language plpgsql
immutable
strict
as $$
declare
  v_raw text := btrim(p_phone);
  v_digits text;
  v_country text := btrim(p_default_country_calling_code);
  v_result text;
begin
  if v_raw = '' then
    raise exception 'customer_phone_required';
  end if;

  if left(v_raw, 1) = '+' then
    v_digits := regexp_replace(substr(v_raw, 2), '[^0-9]', '', 'g');
    v_result := '+' || v_digits;
  elsif left(v_raw, 2) = '00' then
    v_digits := regexp_replace(substr(v_raw, 3), '[^0-9]', '', 'g');
    v_result := '+' || v_digits;
  else
    if v_country !~ '^\+[1-9][0-9]{0,3}$' then
      raise exception 'invalid_default_country_calling_code';
    end if;
    v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');
    if v_country = '+34' and v_digits !~ '^[6789][0-9]{8}$' then
      raise exception 'invalid_spanish_national_phone';
    end if;
    v_result := v_country || v_digits;
  end if;

  if v_result !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid_e164_phone';
  end if;

  return v_result;
end;
$$;

create or replace function public.normalize_reservation_customer_phone_before_write()
returns trigger
language plpgsql
as $$
begin
  new.customer_phone := public.normalize_reservation_phone_e164(new.customer_phone, '+34');
  return new;
end;
$$;

drop trigger if exists reservations_normalize_customer_phone_e164 on public.reservations;
create trigger reservations_normalize_customer_phone_e164
before insert or update of customer_phone on public.reservations
for each row
execute function public.normalize_reservation_customer_phone_before_write();

-- Canonicalize legacy national-format rows without changing their subscriber digits.
update public.reservations
set customer_phone = public.normalize_reservation_phone_e164(customer_phone, '+34')
where customer_phone !~ '^\+[1-9][0-9]{7,14}$';

alter table public.reservations
  drop constraint if exists reservations_customer_phone_e164_chk;

alter table public.reservations
  add constraint reservations_customer_phone_e164_chk
  check (customer_phone ~ '^\+[1-9][0-9]{7,14}$') not valid;

alter table public.reservations
  validate constraint reservations_customer_phone_e164_chk;
