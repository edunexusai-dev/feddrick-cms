'use strict';

/**
 * Executes scheduled publish/unpublish actions (api::publication-schedule). Run by the cron
 * task in config/cron-tasks.js every 20 seconds, so schedules work whether or not anyone has
 * Studio open, and catch up after a restart (anything due and still pending runs then).
 *
 * Reliability rules:
 *  - A job is claimed atomically (pending -> running in one conditional UPDATE); a second run
 *    or a second process cannot execute it again.
 *  - Publishing is bound to the draft version that was scheduled (draftFingerprint = the
 *    draft's updatedAt when it was scheduled). If the draft changed, the job is "blocked" and
 *    nothing is published until an administrator confirms the schedule again.
 *  - Failures are retried with backoff (1, 2, 4, 8 minutes); after 5 attempts the job is
 *    "failed" with its error. Jobs left "running" by a crash return to pending after 5 minutes.
 *  - Publish/unpublish are idempotent: unpublishing something already unpublished is "done".
 */
const SCHEDULE_UID = 'api::publication-schedule.publication-schedule';
const TYPES = { page: 'api::page.page', announcement: 'api::announcement.announcement', faq: 'api::faq.faq' };
const MAX_ATTEMPTS = 5;
const STALE_MS = 5 * 60_000;

module.exports = ({ strapi }) => {
  let running = false;
  const q = () => strapi.db.query(SCHEDULE_UID);

  async function versions(uid, tenant, documentId) {
    const docs = strapi.documents(uid);
    const [draft, published] = await Promise.all([docs.findOne({ documentId, status: 'draft' }), docs.findOne({ documentId, status: 'published' })]);
    const owned = (v) => (v && v.tenant === tenant ? v : null);
    return { draft: owned(draft), published: owned(published) };
  }

  async function audit(job, action, summary) {
    try {
      await strapi.documents('api::audit-entry.audit-entry').create({ data: { tenant: job.tenant, action, contentType: job.contentType, targetId: job.targetId, actorId: 'scheduler', actorName: `Scheduled by ${job.actorName ?? 'an administrator'}`, summary: summary ? String(summary).slice(0, 300) : null } });
    } catch (error) {
      strapi.log.warn(`[scheduler] audit entry not written: ${error.message}`);
    }
  }

  /** Returns the final status for the job. Throws on retryable failures. */
  async function execute(job) {
    const uid = TYPES[job.contentType];
    if (!uid) return { status: 'failed', lastError: 'Unknown content type.' };
    const { draft, published } = await versions(uid, job.tenant, job.targetId);
    if (!draft && !published) return { status: 'failed', lastError: 'The item no longer exists.' };
    const label = (draft ?? published).title ?? (draft ?? published).question ?? '';
    if (job.action === 'publish') {
      if (!draft) return { status: 'failed', lastError: 'There is no draft to publish.' };
      if (job.draftFingerprint && new Date(draft.updatedAt).toISOString() !== job.draftFingerprint) {
        return { status: 'blocked', lastError: 'The draft changed after this publish was scheduled. Review it and confirm the schedule again.' };
      }
      await strapi.documents(uid).publish({ documentId: job.targetId });
      await audit(job, 'scheduled-publish', label);
      return { status: 'done' };
    }
    if (!published) return { status: 'done', lastError: 'Already unpublished.' };
    await strapi.documents(uid).unpublish({ documentId: job.targetId });
    await audit(job, 'scheduled-unpublish', label);
    return { status: 'done' };
  }

  async function runDue(now = new Date()) {
    if (running) return { skipped: true };
    running = true;
    const summary = { done: 0, blocked: 0, failed: 0, retried: 0 };
    try {
      await q().updateMany({ where: { status: 'running', updatedAt: { $lt: new Date(now.getTime() - STALE_MS).toISOString() } }, data: { status: 'pending' } });
      const due = await q().findMany({
        where: { status: 'pending', runAt: { $lte: now.toISOString() }, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now.toISOString() } }] },
        orderBy: { runAt: 'asc' },
        limit: 25,
      });
      for (const job of due) {
        const claim = await q().updateMany({ where: { id: job.id, status: 'pending' }, data: { status: 'running' } });
        if ((claim?.count ?? 0) !== 1) continue;
        try {
          const result = await execute(job);
          await q().update({ where: { id: job.id }, data: { ...result, attempts: (job.attempts ?? 0) + 1, executedAt: new Date().toISOString(), nextAttemptAt: null } });
          summary[result.status === 'done' ? 'done' : result.status === 'blocked' ? 'blocked' : 'failed'] += 1;
        } catch (error) {
          const attempts = (job.attempts ?? 0) + 1;
          const final = attempts >= MAX_ATTEMPTS;
          await q().update({ where: { id: job.id }, data: { status: final ? 'failed' : 'pending', attempts, lastError: String(error.message ?? error).slice(0, 300), nextAttemptAt: final ? null : new Date(Date.now() + 60_000 * 2 ** (attempts - 1)).toISOString() } });
          summary[final ? 'failed' : 'retried'] += 1;
          strapi.log.warn(`[scheduler] ${job.action} ${job.contentType}/${job.targetId} failed (attempt ${attempts}): ${error.message}`);
        }
      }
      if (summary.done + summary.blocked + summary.failed + summary.retried > 0) strapi.log.info(`[scheduler] ${JSON.stringify(summary)}`);
      return summary;
    } finally {
      running = false;
    }
  }

  return { runDue };
};
