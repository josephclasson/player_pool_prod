-- Frozen "original" chalk projection at draft completion (PPG × expected chalk games played, full bracket).

begin;

alter table public.projections
  add column if not exists projection_chalk_original numeric(12, 2),
  add column if not exists projection_original_captured_at timestamptz;

comment on column public.projections.projection_chalk_original is
  'Chalk projection when the draft finished: sum over roster of season PPG × expected chalk tournament games played (bracket sim), not live remaining games.';
comment on column public.projections.projection_original_captured_at is
  'When projection_chalk_original was recorded (typically draft completion).';

commit;
