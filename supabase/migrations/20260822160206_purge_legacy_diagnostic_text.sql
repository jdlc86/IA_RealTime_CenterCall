-- Redaction v1 did not cover every natural phrasing for reservation-holder
-- names or reservation codes. Keep the structural diagnostic event while
-- removing only the potentially identifying legacy transcript fields.
update public.call_diagnostic_events
set details = details - 'redacted_text' - 'redaction_version'
where details ->> 'redaction_version' = '1'
  and details ? 'redacted_text';
