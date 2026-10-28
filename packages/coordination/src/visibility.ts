/** Internal SQL aliases only. Removal is reversible and retains held evidence/audit. */
export const caseVisibleSql=(alias:string)=>`coalesce((SELECT a.action FROM operations_audit a WHERE a.connection_id=${alias}.connection_id AND a.target_id=${alias}.id AND a.action IN ('delete_case','restore_case') ORDER BY a.created_at DESC,a.id DESC LIMIT 1),'')<>'delete_case'`;
