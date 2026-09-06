/** Status → semantic chip class (docs/DESIGN-SYSTEM.md: colour by meaning, never decoration). */
export function chipClass(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'success': case 'done': case 'sent': case 'delivered': case 'active': case 'approved': case 'paid': case 'present': case 'published': case 'taught': return 'chip chip-ok';
    case 'pending': case 'queued': case 'running': case 'scheduled': case 'partial': case 'late': case 'preview': case 'suggested': case 'new': case 'planned': return 'chip chip-warn';
    case 'failed': case 'rejected': case 'overdue': case 'absent': case 'cancelled': case 'locked': case 'suspended': case 'dropped': return 'chip chip-bad';
    case 'skipped': case 'inactive': case 'draft': case 'archived': return 'chip';
    default: return 'chip chip-accent';
  }
}

/** Feed icon class by origin: system handler (accent), rule (teal = automation), cron (amber). */
export function feedClass(kind: 'system' | 'rule' | 'cron'): string {
  return `feed-icon ${kind === 'rule' ? 'feed-rule' : kind === 'cron' ? 'feed-cron' : 'feed-system'}`;
}
