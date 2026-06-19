-- Link a mail thread to the originating report (per-report outreach threads) so a jurisdiction's
-- reply auto-routes back onto the report it answers. Nullable: digest/compose threads have no report.
ALTER TABLE mail_threads ADD COLUMN report_id uuid REFERENCES reports(id) ON DELETE SET NULL;
CREATE INDEX mail_threads_report_idx ON mail_threads (report_id) WHERE report_id IS NOT NULL;

-- Per-contact bounce marker: set when an outbound to this address hard-bounces, so the directory can
-- surface a 'bounced' contact and re-open discovery. Nullable; NULL = no known bounce.
ALTER TABLE jurisdiction_contacts ADD COLUMN bounced_at timestamptz;
