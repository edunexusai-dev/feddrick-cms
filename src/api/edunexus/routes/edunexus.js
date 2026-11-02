'use strict';

/**
 * EduNexusAI integration routes (/api/edunexus/...). Content-API authentication applies:
 * only an API token granted these exact actions can call them (see STRAPI_CMS_IMPLEMENTATION.md).
 */
const route = (method, path, handler) => ({ method, path, handler: `edunexus.${handler}`, config: { policies: [] } });

module.exports = {
  routes: [
    route('GET', '/edunexus/audit', 'auditLog'),
    route('GET', '/edunexus/media', 'mediaList'),
    route('POST', '/edunexus/media', 'mediaUpload'),
    route('GET', '/edunexus/content/:type', 'list'),
    route('POST', '/edunexus/content/:type', 'create'),
    route('GET', '/edunexus/content/:type/:documentId', 'findOne'),
    route('PUT', '/edunexus/content/:type/:documentId', 'update'),
    route('DELETE', '/edunexus/content/:type/:documentId', 'remove'),
    route('POST', '/edunexus/content/:type/:documentId/publish', 'publish'),
    route('POST', '/edunexus/content/:type/:documentId/unpublish', 'unpublish'),
    route('POST', '/edunexus/content/:type/:documentId/discard', 'discard'),
    route('GET', '/edunexus/content/:type/:documentId/schedule', 'scheduleGet'),
    route('PUT', '/edunexus/content/:type/:documentId/schedule', 'scheduleSet'),
  ],
};
