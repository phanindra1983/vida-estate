CREATE TRIGGER audit_no_update BEFORE UPDATE ON AuditLog BEGIN SELECT RAISE(ABORT, 'The audit trail is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON AuditLog BEGIN SELECT RAISE(ABORT, 'The audit trail is append-only'); END;
