'use strict';

/** Scheduled publish/unpublish for EduNexusAI content (see src/api/edunexus/services/scheduler.js). */
module.exports = {
  cmsPublicationSchedules: {
    task: async ({ strapi }) => {
      try {
        await strapi.service('api::edunexus.scheduler').runDue();
      } catch (error) {
        strapi.log.error(`[scheduler] run failed: ${error.message}`);
      }
    },
    options: { rule: '*/20 * * * * *' },
  },
};
