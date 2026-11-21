CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'The audit trail is append-only'; END; $$;
DROP TRIGGER IF EXISTS audit_no_update ON "AuditLog";
CREATE TRIGGER audit_no_update BEFORE UPDATE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
DROP TRIGGER IF EXISTS audit_no_delete ON "AuditLog";
CREATE TRIGGER audit_no_delete BEFORE DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
