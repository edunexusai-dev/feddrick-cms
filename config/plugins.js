// Campus content uses images only. SVG is refused (it can carry script), as are all
// executable and document types; size is capped in `sizeLimit` below.
const allowedMediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const deniedTypes = ['image/svg+xml'];

module.exports = () => ({
  'users-permissions': {
    config: {
      jwtManagement: 'refresh',
      sessions: {
        httpOnly: true,
      },
    },
  },
  upload: {
    config: {
      sizeLimit: 5 * 1024 * 1024,
      security: {
        allowedTypes: allowedMediaTypes,
        deniedTypes,
      },
    },
  },
});
