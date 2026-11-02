'use strict';

/**
 * EduNexusAI integration API: the only surface the EduNexusAI backend uses.
 *
 * - Reachable only with the custom API token held by the EduNexusAI backend (no public or
 *   authenticated-user role has any of these permissions).
 * - Every call names a tenant; every document read or written is re-checked against it, so
 *   another tenant's document behaves as if it did not exist (404).
 * - Only the fields listed in WRITABLE can be written; `tenant` comes from the call, never
 *   from the data.
 * - Draft & publish: writes change the draft; publish/unpublish/discard use the Document
 *   Service, so the published version only changes when explicitly published.
 * - Every write is recorded in api::audit-entry (in this CMS database).
 */

const TYPES = {
  page: 'api::page.page',
  'dashboard-layout': 'api::dashboard-layout.dashboard-layout',
  announcement: 'api::announcement.announcement',
  faq: 'api::faq.faq',
  form: 'api::form.form',
};
const SCHEDULE_UID = 'api::publication-schedule.publication-schedule';
/** Content types whose publication can be scheduled. */
const SCHEDULABLE = ['page', 'announcement', 'faq'];

// Community audiences (signed-in people) plus, for pages, announcements and FAQs, the public (no sign-in).
// Forms have no public audience: every submission comes from a signed-in person.
const AUDIENCE = ['audienceStudents', 'audienceFaculty', 'audienceStaff', 'audienceAlumni'];
const PUBLIC = ['audiencePublic'];
const WHO = ['authorName', 'updatedByName'];
const WRITABLE = {
  page: ['title', 'slug', 'summary', 'template', 'showInNav', 'navLabel', 'sortOrder', 'layout', ...AUDIENCE, ...PUBLIC, ...WHO],
  'dashboard-layout': ['persona', 'layout', ...WHO],
  announcement: ['title', 'summary', 'body', 'bodyFormat', 'category', 'priority', 'pinned', 'ctaLabel', 'ctaUrl', 'expiresAt', ...AUDIENCE, ...PUBLIC, ...WHO],
  faq: ['question', 'answer', 'answerFormat', 'category', 'sortOrder', ...AUDIENCE, ...PUBLIC, ...WHO],
  form: ['name', 'description', 'fields', 'submitLabel', 'successMessage', 'recipientEmail', 'notificationSubject', ...AUDIENCE, ...WHO],
};
const AUDIENCE_FIELD = { students: 'audienceStudents', faculty: 'audienceFaculty', staff: 'audienceStaff', alumni: 'audienceAlumni', public: 'audiencePublic' };
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_PAGE = 200;

const fail = (ctx, status, name, message, details) => {
  ctx.status = status;
  ctx.body = { data: null, error: { status, name, message, details: details ?? {} } };
};

function typeOf(ctx) {
  const uid = TYPES[ctx.params.type];
  if (!uid) {
    fail(ctx, 404, 'NotFoundError', 'Unknown content type.');
    return null;
  }
  return uid;
}

function tenantOf(ctx, source) {
  const tenant = String(source?.tenant ?? '');
  if (!TENANT_RE.test(tenant)) {
    fail(ctx, 400, 'ValidationError', 'A valid tenant is required.');
    return null;
  }
  return tenant;
}

const pick = (type, data) => Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => WRITABLE[type].includes(key)));

/** draft | published | modified, from the draft and published versions of one document. */
function stateOf(draft, published) {
  if (!published) return 'draft';
  // Publishing gives both versions the same updatedAt, so any later draft edit is newer.
  const changed = draft && new Date(draft.updatedAt).getTime() > new Date(published.updatedAt).getTime();
  return changed ? 'modified' : 'published';
}

async function versions(uid, tenant, documentId) {
  const docs = strapi.documents(uid);
  const [draft, published] = await Promise.all([
    docs.findOne({ documentId, status: 'draft' }),
    docs.findOne({ documentId, status: 'published' }),
  ]);
  const owned = (v) => (v && v.tenant === tenant ? v : null);
  return { draft: owned(draft), published: owned(published) };
}

const present = (draft, published) => ({ ...(draft ?? published), state: stateOf(draft, published), publishedVersion: published ?? null });

/* ------------------------------------------------------------- schedules */

const scheduleDto = (j) => ({ id: j.id, action: j.action, runAt: j.runAt, status: j.status, attempts: j.attempts ?? 0, lastError: j.lastError ?? null, executedAt: j.executedAt ?? null, actorName: j.actorName ?? null });

/** Open (pending/running/blocked) schedules for documents of one type, keyed by documentId. */
async function openSchedules(tenant, type, documentIds) {
  if (!SCHEDULABLE.includes(type)) return new Map();
  const where = { tenant, contentType: type, status: { $in: ['pending', 'running', 'blocked'] } };
  if (documentIds) where.targetId = { $in: documentIds };
  const rows = await strapi.db.query(SCHEDULE_UID).findMany({ where, orderBy: { runAt: 'asc' } });
  const map = new Map();
  for (const row of rows) {
    const entry = map.get(row.targetId) ?? {};
    entry[row.action] = scheduleDto(row);
    map.set(row.targetId, entry);
  }
  return map;
}

/** Documents whose scheduled unpublish time has passed (hidden from delivery even before the job runs). */
async function dueUnpublish(tenant, type) {
  if (!SCHEDULABLE.includes(type)) return new Set();
  const rows = await strapi.db.query(SCHEDULE_UID).findMany({ where: { tenant, contentType: type, action: 'unpublish', status: { $in: ['pending', 'running'] }, runAt: { $lte: new Date().toISOString() } }, select: ['targetId'] });
  return new Set(rows.map((r) => r.targetId));
}

async function cancelSchedules(tenant, type, documentId, actions) {
  await strapi.db.query(SCHEDULE_UID).updateMany({ where: { tenant, contentType: type, targetId: documentId, action: { $in: actions }, status: { $in: ['pending', 'blocked'] } }, data: { status: 'cancelled' } });
}

/** Adds `schedule` and the 'scheduled' state (a draft with a pending publish) to a presented document. */
function withSchedule(doc, schedule) {
  if (!doc) return doc;
  const sched = schedule ?? {};
  const state = doc.state === 'draft' && sched.publish && sched.publish.status !== 'blocked' ? 'scheduled' : doc.state;
  return { ...doc, state, schedule: { publish: sched.publish ?? null, unpublish: sched.unpublish ?? null } };
}

async function audit(tenant, action, type, documentId, actor, summary) {
  try {
    await strapi.documents('api::audit-entry.audit-entry').create({
      data: { tenant, action, contentType: type, targetId: documentId ?? null, actorId: actor?.id ? String(actor.id).slice(0, 64) : null, actorName: actor?.name ? String(actor.name).slice(0, 160) : null, summary: summary ? String(summary).slice(0, 300) : null },
    });
  } catch (error) {
    strapi.log.warn(`[edunexus] audit entry not written: ${error.message}`);
  }
}

async function assertUnique(ctx, type, uid, tenant, data, documentId) {
  if (type === 'page' && data.slug) {
    const clash = await strapi.documents(uid).findMany({ filters: { tenant, slug: data.slug }, status: 'draft', limit: 2 });
    if (clash.some((d) => d.documentId !== documentId)) {
      fail(ctx, 409, 'ConflictError', `Another page already uses the address "${data.slug}".`, { field: 'slug' });
      return false;
    }
  }
  if (type === 'dashboard-layout' && data.persona) {
    const clash = await strapi.documents(uid).findMany({ filters: { tenant, persona: data.persona }, status: 'draft', limit: 2 });
    if (clash.some((d) => d.documentId !== documentId)) {
      fail(ctx, 409, 'ConflictError', `A ${data.persona} dashboard layout already exists for this tenant.`, { field: 'persona' });
      return false;
    }
  }
  return true;
}

function validationFailure(ctx, error) {
  if (error?.name === 'ValidationError' || error?.details?.errors) {
    fail(ctx, 400, 'ValidationError', error.message, { errors: error.details?.errors ?? [] });
    return true;
  }
  return false;
}

module.exports = {
  /** List documents of one type for a tenant. status=published returns only published versions. */
  async list(ctx) {
    const uid = typeOf(ctx);
    if (!uid) return;
    const tenant = tenantOf(ctx, ctx.query);
    if (!tenant) return;
    const type = ctx.params.type;
    const filters = { tenant };
    if (ctx.query.slug) filters.slug = String(ctx.query.slug);
    if (ctx.query.persona) filters.persona = String(ctx.query.persona);
    const requested = String(ctx.query.audiences ?? '').split(',').filter(Boolean);
    const audiences = requested.map((a) => AUDIENCE_FIELD[a]).filter(Boolean);
    // An audience this type does not have (e.g. public forms) matches nothing rather than everything.
    const known = audiences.filter((field) => strapi.contentType(uid).attributes[field]);
    if (requested.length && !known.length) {
      ctx.body = { data: [] };
      return;
    }
    if (known.length) filters.$or = known.map((field) => ({ [field]: true }));
    if (type === 'announcement' && ctx.query.live === 'true') {
      filters.$and = [{ $or: [{ expiresAt: { $null: true } }, { expiresAt: { $gt: new Date().toISOString() } }] }];
    }
    const sort = type === 'announcement' ? ['pinned:desc', 'updatedAt:desc'] : type === 'faq' ? ['sortOrder:asc', 'question:asc'] : type === 'page' ? ['sortOrder:asc', 'title:asc'] : ['updatedAt:desc'];
    const limit = Math.min(Number(ctx.query.limit) || MAX_PAGE, MAX_PAGE);
    const docs = strapi.documents(uid);
    if (ctx.query.status === 'published') {
      const rows = await docs.findMany({ filters, status: 'published', sort, limit });
      const hidden = await dueUnpublish(tenant, type);
      ctx.body = { data: rows.filter((r) => !hidden.has(r.documentId)).map((r) => ({ ...r, state: 'published' })) };
      return;
    }
    const drafts = await docs.findMany({ filters, status: 'draft', sort, limit });
    const published = drafts.length ? await docs.findMany({ filters: { tenant, documentId: { $in: drafts.map((d) => d.documentId) } }, status: 'published', limit: MAX_PAGE }) : [];
    const pubById = new Map(published.map((p) => [p.documentId, p]));
    const schedules = await openSchedules(tenant, type, drafts.map((d) => d.documentId));
    ctx.body = { data: drafts.map((d) => withSchedule({ ...d, state: stateOf(d, pubById.get(d.documentId)), publishedAt: pubById.get(d.documentId)?.publishedAt ?? null }, schedules.get(d.documentId))) };
  },

  async findOne(ctx) {
    const uid = typeOf(ctx);
    if (!uid) return;
    const tenant = tenantOf(ctx, ctx.query);
    if (!tenant) return;
    const { draft, published } = await versions(uid, tenant, ctx.params.documentId);
    if (ctx.query.status === 'published') {
      if (!published || (await dueUnpublish(tenant, ctx.params.type)).has(ctx.params.documentId)) return fail(ctx, 404, 'NotFoundError', 'Not found.');
      ctx.body = { data: { ...published, state: 'published' } };
      return;
    }
    if (!draft && !published) return fail(ctx, 404, 'NotFoundError', 'Not found.');
    const schedules = await openSchedules(tenant, ctx.params.type, [ctx.params.documentId]);
    ctx.body = { data: withSchedule(present(draft, published), schedules.get(ctx.params.documentId)) };
  },

  async create(ctx) {
    const uid = typeOf(ctx);
    if (!uid) return;
    const body = ctx.request.body ?? {};
    const tenant = tenantOf(ctx, body);
    if (!tenant) return;
    const type = ctx.params.type;
    const data = pick(type, body.data);
    if (!(await assertUnique(ctx, type, uid, tenant, data))) return;
    try {
      const created = await strapi.documents(uid).create({ data: { ...data, tenant } });
      await audit(tenant, 'create', type, created.documentId, body.actor, data.title ?? data.question ?? data.persona ?? data.name);
      ctx.status = 201;
      ctx.body = { data: present(created, null) };
    } catch (error) {
      if (!validationFailure(ctx, error)) throw error;
    }
  },

  async update(ctx) {
    const uid = typeOf(ctx);
    if (!uid) return;
    const body = ctx.request.body ?? {};
    const tenant = tenantOf(ctx, body);
    if (!tenant) return;
    const type = ctx.params.type;
    const { documentId } = ctx.params;
    const before = await versions(uid, tenant, documentId);
    if (!before.draft && !before.published) return fail(ctx, 404, 'NotFoundError', 'Not found.');
    const data = pick(type, body.data);
    delete data.persona; // a dashboard layout's persona is fixed at creation
    if (!(await assertUnique(ctx, type, uid, tenant, data, documentId))) return;
    try {
      const updated = await strapi.documents(uid).update({ documentId, data, status: 'draft' });
      await audit(tenant, 'update', type, documentId, body.actor, updated.title ?? updated.question ?? updated.persona ?? updated.name);
      // A scheduled publish was confirmed for the previous draft; never publish an unreviewed edit.
      if (SCHEDULABLE.includes(type)) {
        await strapi.db.query(SCHEDULE_UID).updateMany({ where: { tenant, contentType: type, targetId: documentId, action: 'publish', status: 'pending' }, data: { status: 'blocked', lastError: 'The draft changed after this publish was scheduled. Review it and confirm the schedule again.' } });
      }
      const schedules = await openSchedules(tenant, type, [documentId]);
      ctx.body = { data: withSchedule(present(updated, before.published), schedules.get(documentId)) };
    } catch (error) {
      if (!validationFailure(ctx, error)) throw error;
    }
  },

  async publish(ctx) {
    return transition(ctx, 'publish');
  },
  async unpublish(ctx) {
    return transition(ctx, 'unpublish');
  },
  async discard(ctx) {
    return transition(ctx, 'discard');
  },

  async remove(ctx) {
    const uid = typeOf(ctx);
    if (!uid) return;
    const tenant = tenantOf(ctx, ctx.query);
    if (!tenant) return;
    const { documentId } = ctx.params;
    const before = await versions(uid, tenant, documentId);
    if (!before.draft && !before.published) return fail(ctx, 404, 'NotFoundError', 'Not found.');
    await strapi.documents(uid).delete({ documentId });
    await cancelSchedules(tenant, ctx.params.type, documentId, ['publish', 'unpublish']);
    await audit(tenant, 'delete', ctx.params.type, documentId, { id: ctx.query.actorId, name: ctx.query.actorName }, (before.draft ?? before.published).title ?? null);
    ctx.body = { data: { documentId, deleted: true } };
  },

  async auditLog(ctx) {
    const tenant = tenantOf(ctx, ctx.query);
    if (!tenant) return;
    const rows = await strapi.documents('api::audit-entry.audit-entry').findMany({ filters: { tenant }, sort: ['createdAt:desc'], limit: Math.min(Number(ctx.query.limit) || 50, 200) });
    ctx.body = { data: rows };
  },

  /** Open schedules of one document. */
  async scheduleGet(ctx) {
    const uid = typeOf(ctx);
    if (!uid) return;
    if (!SCHEDULABLE.includes(ctx.params.type)) return fail(ctx, 404, 'NotFoundError', 'This content type cannot be scheduled.');
    const tenant = tenantOf(ctx, ctx.query);
    if (!tenant) return;
    const { documentId } = ctx.params;
    const before = await versions(uid, tenant, documentId);
    if (!before.draft && !before.published) return fail(ctx, 404, 'NotFoundError', 'Not found.');
    const sched = (await openSchedules(tenant, ctx.params.type, [documentId])).get(documentId) ?? {};
    ctx.body = { data: { publish: sched.publish ?? null, unpublish: sched.unpublish ?? null } };
  },

  /**
   * Set or clear scheduled actions. Body: { tenant, actor, publishAt?, unpublishAt? } where an
   * ISO time sets (replacing any open schedule of that action), null cancels, and an absent
   * key leaves it unchanged. A scheduled publish is bound to the current draft version: if the
   * draft is edited afterwards, the job is blocked instead of publishing unreviewed content.
   */
  async scheduleSet(ctx) {
    const uid = typeOf(ctx);
    if (!uid) return;
    const type = ctx.params.type;
    if (!SCHEDULABLE.includes(type)) return fail(ctx, 404, 'NotFoundError', 'This content type cannot be scheduled.');
    const body = ctx.request.body ?? {};
    const tenant = tenantOf(ctx, body);
    if (!tenant) return;
    const { documentId } = ctx.params;
    const before = await versions(uid, tenant, documentId);
    if (!before.draft && !before.published) return fail(ctx, 404, 'NotFoundError', 'Not found.');
    const now = Date.now();
    const parse = (v) => (v === null || v === undefined ? v : new Date(v));
    const publishAt = parse(body.publishAt);
    const unpublishAt = parse(body.unpublishAt);
    for (const [name, value] of [['publishAt', publishAt], ['unpublishAt', unpublishAt]]) {
      if (value && Number.isNaN(value.getTime())) return fail(ctx, 400, 'ValidationError', `${name} is not a valid time.`, { field: name });
      if (value && value.getTime() < now + 30_000) return fail(ctx, 400, 'ValidationError', 'Scheduled times must be at least a minute in the future.', { field: name });
    }
    const open = (await openSchedules(tenant, type, [documentId])).get(documentId) ?? {};
    const effectivePublish = publishAt === undefined ? (open.publish ? new Date(open.publish.runAt) : null) : publishAt;
    const effectiveUnpublish = unpublishAt === undefined ? (open.unpublish ? new Date(open.unpublish.runAt) : null) : unpublishAt;
    if (effectiveUnpublish && effectivePublish && effectiveUnpublish <= effectivePublish) return fail(ctx, 400, 'ValidationError', 'The unpublish time must be after the publish time.', { field: 'unpublishAt' });
    if (effectiveUnpublish && !effectivePublish && !before.published) return fail(ctx, 409, 'ConflictError', 'This item is not published. Schedule a publish time, or publish it first.', { field: 'unpublishAt' });
    if (effectivePublish && !before.draft) return fail(ctx, 409, 'ConflictError', 'There is no draft to publish.', { field: 'publishAt' });
    const actor = body.actor ?? {};
    const make = (action, runAt) => strapi.db.query(SCHEDULE_UID).create({
      data: { tenant, contentType: type, targetId: documentId, action, runAt: runAt.toISOString(), status: 'pending', attempts: 0, draftFingerprint: action === 'publish' ? new Date(before.draft.updatedAt).toISOString() : null, actorId: actor.id ? String(actor.id).slice(0, 64) : null, actorName: actor.name ? String(actor.name).slice(0, 160) : null },
    });
    if (publishAt !== undefined) {
      await cancelSchedules(tenant, type, documentId, ['publish']);
      if (publishAt) await make('publish', publishAt);
    }
    if (unpublishAt !== undefined) {
      await cancelSchedules(tenant, type, documentId, ['unpublish']);
      if (unpublishAt) await make('unpublish', unpublishAt);
    }
    const title = (before.draft ?? before.published).title ?? (before.draft ?? before.published).question ?? null;
    const what = [publishAt !== undefined && (publishAt ? `publish at ${publishAt.toISOString()}` : 'publish cancelled'), unpublishAt !== undefined && (unpublishAt ? `unpublish at ${unpublishAt.toISOString()}` : 'unpublish cancelled')].filter(Boolean).join('; ');
    await audit(tenant, 'schedule', type, documentId, actor, `${title ?? ''} (${what})`.slice(0, 300));
    const sched = (await openSchedules(tenant, type, [documentId])).get(documentId) ?? {};
    ctx.body = { data: { publish: sched.publish ?? null, unpublish: sched.unpublish ?? null } };
  },

  /** Image upload, tagged with the tenant (caption) so media lists stay per tenant. */
  async mediaUpload(ctx) {
    const tenant = tenantOf(ctx, ctx.request.body);
    if (!tenant) return;
    const file = ctx.request.files?.file;
    if (!file || Array.isArray(file)) return fail(ctx, 400, 'ValidationError', 'Send exactly one file in the "file" field.');
    const alt = String(ctx.request.body?.alternativeText ?? '').slice(0, 200);
    try {
      const [uploaded] = await strapi.plugin('upload').service('upload').upload({ data: { fileInfo: { caption: `tenant:${tenant}`, alternativeText: alt, name: file.originalFilename ?? file.name } }, files: file });
      await audit(tenant, 'upload', 'media', String(uploaded.id), { id: ctx.request.body?.actorId, name: ctx.request.body?.actorName }, uploaded.name);
      ctx.status = 201;
      ctx.body = { data: mediaDto(uploaded) };
    } catch (error) {
      return fail(ctx, 400, 'ValidationError', error.message || 'The file was refused.');
    }
  },

  async mediaList(ctx) {
    const tenant = tenantOf(ctx, ctx.query);
    if (!tenant) return;
    const files = await strapi.db.query('plugin::upload.file').findMany({ where: { caption: `tenant:${tenant}` }, orderBy: { createdAt: 'desc' }, limit: 200 });
    ctx.body = { data: files.map(mediaDto) };
  },
};

const mediaDto = (f) => ({ id: f.id, name: f.name, url: f.url, mime: f.mime, size: f.size, width: f.width ?? null, height: f.height ?? null, alternativeText: f.alternativeText ?? null, createdAt: f.createdAt });

async function transition(ctx, action) {
  const uid = typeOf(ctx);
  if (!uid) return;
  const body = ctx.request.body ?? {};
  const tenant = tenantOf(ctx, body);
  if (!tenant) return;
  const { documentId } = ctx.params;
  const before = await versions(uid, tenant, documentId);
  if (!before.draft && !before.published) return fail(ctx, 404, 'NotFoundError', 'Not found.');
  const docs = strapi.documents(uid);
  try {
    if (action === 'publish') {
      await docs.publish({ documentId });
      await cancelSchedules(tenant, ctx.params.type, documentId, ['publish']);
    }
    if (action === 'unpublish') {
      if (!before.published) return fail(ctx, 409, 'ConflictError', 'This item is not published.');
      await docs.unpublish({ documentId });
      await cancelSchedules(tenant, ctx.params.type, documentId, ['publish', 'unpublish']);
    }
    if (action === 'discard') {
      if (!before.published) return fail(ctx, 409, 'ConflictError', 'There is no published version to return to.');
      await docs.discardDraft({ documentId });
    }
  } catch (error) {
    if (!validationFailure(ctx, error)) throw error;
    return;
  }
  const after = await versions(uid, tenant, documentId);
  await audit(tenant, action, ctx.params.type, documentId, body.actor, (after.draft ?? after.published)?.title ?? null);
  const schedules = await openSchedules(tenant, ctx.params.type, [documentId]);
  ctx.body = { data: withSchedule(present(after.draft, after.published), schedules.get(documentId)) };
}
