-- Phone identity is global. PostgreSQL may normalize presentation syntax, but
-- it must never invent a country calling code for a reservation identity.
create or replace function public.normalize_reservation_phone_e164(
  p_phone text,
  p_default_country_calling_code text default null
)
returns text
language plpgsql
immutable
strict
as $$
declare
  v_raw text := btrim(p_phone);
  v_digits text;
  v_country text := nullif(btrim(coalesce(p_default_country_calling_code, '')), '');
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
    if v_country is null then
      raise exception 'national_phone_requires_explicit_country_context';
    end if;
    if v_country !~ '^\+[1-9][0-9]{0,3}$' then
      raise exception 'invalid_default_country_calling_code';
    end if;
    v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');
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
  -- Reservation writes must already carry a globally unambiguous identity.
  -- For the caller this comes from trusted SIP/Telnyx Caller ID; alternate
  -- contacts must carry their own country calling code.
  new.customer_phone := public.normalize_reservation_phone_e164(new.customer_phone, null);
  return new;
end;
$$;
