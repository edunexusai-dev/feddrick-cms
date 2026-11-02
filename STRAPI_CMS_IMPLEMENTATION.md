# Feddrick CMS and EduNexusAI Studio: implementation notes

This document describes what is actually built: a Strapi CMS (`feddrick-cms/`) and a visual page and dashboard builder ("Studio") inside EduNexusAI. It covers how the parts connect, how to run them, and the safety boundaries. It does not contain credentials.

Status (2026-10-17, second iteration): implemented, tested, and verified end to end against the real Strapi instance. Studio now opens inside the portal shell with a CMS rail, the editor has working resize handles, and **published dashboard layouts are on** in the local development environment (`CMS_LAYOUTS_ENABLED=true`, see section 9.4). Section 9 describes the second iteration, section 10 the third (in-place editing and independent scrolling) section 11 the Admin dashboard integration, section 12 the UI refinements and section 13 scheduled publishing, rich text, forms and video; where they differ from earlier sections, the later section is current.

---

## 1. Architecture

```
Browser (EduNexusAI React app)
   │  only ever calls the EduNexusAI API with the user's own session
   ▼
EduNexusAI backend (Express, /api/v1)
   ├─ /studio/*   requireAuth + requireRole('ADMIN'), tenant = session tenant
   ├─ /content/*  requireAuth, published content for the caller's audiences only
   │              (/content/media/:file is public image bytes, like Strapi's /uploads)
   └─ cms module (src/modules/cms)
        cmsClient.js  → the ONLY code that talks to Strapi (server-side token, timeout)
        cmsService.js → validation, tenant/audience rules, delivery, widget catalogue
   │
   ▼  Bearer <custom API token>, server to server
Strapi 5 (feddrick-cms, 127.0.0.1:1338)
   └─ /api/edunexus/*  custom, tenant-scoped integration API (no public REST for content types)
   │
   ▼
PostgreSQL "feddrick_cms" on DBngin server "feddrick-strapi" (127.0.0.1:5438)
```

Principles:

- **The browser never talks to Strapi** and never holds a CMS token. The token is only in `edunexus/backend/.env` (git-ignored).
- **The tenant always comes from the signed-in session** (`req.auth.tenantSlug`). Any `tenant` sent by a client is ignored. Strapi re-checks the tenant on every document it reads or writes, so another tenant's document behaves as if it did not exist (404).
- **Drafts are never delivered.** Delivery endpoints ask Strapi for `status=published` only. Studio (ADMIN only) is the only place drafts are visible.
- **Audiences are enforced on the server.** STUDENT → `students`, FACULTY → `faculty`, ADMIN → `staff`.
- **Layouts are validated twice**, against the shared block registry `edunexus/shared/cmsBlocks.js`: once before saving (Studio) and again before delivery. Unknown blocks, unknown properties, unsafe URLs, wrong contexts, excessive depth, block counts or size are rejected or stripped.
- **The CMS stores content only**: pages, dashboard layouts, announcements, help articles (FAQs), media and its own audit log. No grades, attendance, enrolments, course records or other SIS/LMS data.
- **Failure is safe.** If the CMS is not configured, unreachable, or returns an invalid layout, dashboards render their original built-in layout and the rest of the portal keeps working.

## 2. Databases and isolation

| Server (DBngin) | Port | Database | Used by | Touched by this work? |
|---|---|---|---|---|
| existing app server | 5432 | `edunexusai` | EduNexusAI | **No.** Read-only checks only (83 tables, 0 CMS tables, 34 users, 12 migrations, unchanged). |
| existing app server | 5432 | `edunexusai_test` | EduNexusAI test suite | Used by the automated tests and the local verification run, as before. No schema change. |
| existing | 5434 | `campuscore` | CampusCore SIS | No. |
| experiment | 5436 | (experimental Strapi) | prototype project | No. |
| **feddrick-strapi** | **5438** | **`feddrick_cms`** | **Strapi** | **New, dedicated.** 46 tables created by Strapi. |

No Prisma migration, schema change, seed, reset or data write was made against the EduNexusAI database. The Studio dashboard editor **reads** the existing widget definitions (`widgetDefinition` where `category = 'dashboard'`) to know which student widgets exist; it never writes to them.

## 3. Strapi project (`feddrick-cms/`)

- Strapi 5.56.0 (JavaScript), created with the official `create-strapi` CLI, `pg` client, SQLite and Strapi Cloud plugin removed.
- `config/plugins.js`: uploads limited to PNG, JPEG, WebP and GIF (SVG explicitly denied), 5 MB.
- Telemetry and promotional flags off.

### Content types (all `draftAndPublish` unless noted, all with a required `tenant`)

| Type | Main fields |
|---|---|
| `page` | title, slug (per-tenant unique), summary, template, showInNav, navLabel, sortOrder, layout (JSON), audienceStudents/Faculty/Staff, authorName, updatedByName |
| `dashboard-layout` | persona (`student` / `faculty` / `admin`, one per tenant), layout (JSON) |
| `announcement` | title, summary, body (Markdown), category, priority, pinned, ctaLabel, ctaUrl, expiresAt, audiences |
| `faq` | question, answer (Markdown), category, sortOrder, audiences |
| `audit-entry` | (no draft/publish) action, contentType, targetId, actorId, actorName, summary |

These types have **no public REST routes**. The only API surface is the custom integration API.

### Integration API (`src/api/edunexus`)

| Method and path | Action |
|---|---|
| `GET /api/edunexus/content/:type?tenant=…[&status=published&slug&persona&audiences&live]` | list |
| `GET /api/edunexus/content/:type/:documentId?tenant=…` | findOne (draft + published state) |
| `POST /api/edunexus/content/:type` | create draft (`{ tenant, data, actor }`) |
| `PUT /api/edunexus/content/:type/:documentId` | update draft |
| `POST …/:documentId/publish` · `/unpublish` · `/discard` | publication transitions |
| `DELETE /api/edunexus/content/:type/:documentId?tenant=…` | delete |
| `GET /api/edunexus/audit?tenant=…` | audit log |
| `GET` / `POST /api/edunexus/media` | tenant-tagged image list and upload |

Only fields in a per-type allowlist are written; `tenant` always comes from the call. Every write creates an `audit-entry`. Item state is `draft`, `published` or `modified` (published, with newer unpublished edits).

### API token (least privilege)

A Strapi **custom** API token named "EduNexusAI backend", unlimited lifespan, with only these permissions:
`api::edunexus.edunexus.{list, findOne, create, update, remove, publish, unpublish, discard, auditLog, mediaList, mediaUpload}`.

Verified: the token gets 403 on `/api/users` and `/api/upload/files` and 401 on admin endpoints; anonymous requests to the integration API get 403.

To rotate it: Strapi admin → Settings → API Tokens → regenerate (or create a new custom token with the same permissions), put the value in `edunexus/backend/.env` as `CMS_API_TOKEN`, restart the EduNexusAI backend.

### Admin account

A super-admin was created with the official CLI (`npx strapi admin:create-user`), email `cms-admin@feddrick.edu`. The password is not recorded in this repository. It was handed over once, outside the repository; change it after first sign-in (Strapi admin → profile). Additional editors should get their own accounts.

Day-to-day editing is meant to happen in EduNexusAI Studio. The Strapi admin is for CMS administration (accounts, tokens, media housekeeping).

## 4. EduNexusAI backend changes

New:

- `src/modules/cms/cmsClient.js`: HTTP client for Strapi. Maps failures to `CMS_NOT_CONFIGURED` (503), `CMS_UNAVAILABLE` (503), `CMS_AUTH_FAILED` (502, the token is never echoed), and passes 400/404/409 through.
- `src/modules/cms/cmsService.js`: zod schemas for page, announcement and FAQ; layout validation; Studio CRUD and transitions; dashboard layouts (widget catalogue per persona); media upload (type allowlist, magic-number check, max 3 MB, safe file name); delivery (navigation pages, a single page, dashboard layout, announcements, FAQs).
- `src/modules/cms/cmsRoutes.js`: `studioRoutes` and `contentRoutes`.
- `../shared/cmsBlocks.js` (shared with the frontend): the block registry and validator.

Changed (additive):

- `src/config/env.js`: added `cmsConfig()`.
- `src/routes/index.js`: mounted `/studio` and `/content`.
- `.env.example`: CMS placeholders.
- `tests/helpers/testEnv.js`: CMS variables are blanked for the test suite (like the SIS and Moodle variables), so tests never call the real CMS.

### Endpoints

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/v1/studio/meta` | ADMIN | CMS status, admin URL, layouts flag |
| `GET/POST /api/v1/studio/:type`, `GET/PUT/DELETE /api/v1/studio/:type/:id`, `POST …/:id/(publish\|unpublish\|discard)` | ADMIN | pages, announcements, FAQs |
| `GET/PUT/DELETE /api/v1/studio/dashboards/:persona`, `POST …/:persona/(publish\|unpublish\|discard)` | ADMIN | dashboard layouts |
| `GET/POST /api/v1/studio/media`, `GET /api/v1/studio/audit` | ADMIN | media, change history |
| `GET /api/v1/content/pages`, `/pages/:slug` | signed in | published pages for the caller's audiences |
| `GET /api/v1/content/dashboard-layouts/:persona` | signed in, matching role (otherwise 403) | published layout, or `layout: null` |
| `GET /api/v1/content/announcements`, `/faqs` | signed in | published, live items for the caller's audiences |
| `GET /api/v1/content/media/:file` | public | image bytes only (`image/png\|jpeg\|webp\|gif`, `nosniff`) |

### Configuration (`edunexus/backend/.env`, never committed)

```
CMS_URL=http://127.0.0.1:1338
CMS_ADMIN_URL=http://localhost:1338/admin
CMS_API_TOKEN=<custom API token from Strapi>
CMS_TIMEOUT_MS=8000
CMS_LAYOUTS_ENABLED=false
```

`CMS_LAYOUTS_ENABLED=true` applies published Studio dashboard layouts to the live dashboards. With `false`, layouts can still be designed and published in Studio, but every dashboard renders its built-in layout.

## 5. EduNexusAI frontend changes

New:

- `src/pages/studio/*`: Studio (lazy-loaded at `/studio/*` inside the portal shell, behind `ProtectedRoute` + `RoleRoute allow={['ADMIN']}`; see section 9.1):
  - **Activity** (formerly Overview): counts and recent changes (audit log).
  - **Pages**: list, *Add page* with templates, full-screen visual editor, admin-only draft preview.
  - **Dashboards**: Student, Faculty and Admin dashboard editors.
  - **News** and **Help articles**: form editors with live Markdown preview.
  - **Media**: image upload and library.
- `src/components/cms/*`: block components, Puck configuration, page renderer, Markdown renderer (no raw HTML, safe URLs only), dashboard layout hook (`useCmsDashboardLayout`, `applyCmsLayout`), navigation hook, help articles section, templates.
- `src/pages/cms/CmsPage.jsx` (`/pages/:slug`) and `CampusNewsPage.jsx` (`/campus/news`).
- `src/services/api/cmsApi.js` (`contentApi`, `studioApi`).

Changed (additive; behaviour is unchanged when there is no CMS content):

| File | Change | Why |
|---|---|---|
| `App.jsx` | Routes for `/studio/*`, `/pages/:slug`, `/campus/news` | Studio and delivered pages |
| `layouts/Header.jsx` | "Studio" item in the account menu, ADMIN only | Entry point |
| `layouts/navigation.js`, `layouts/Sidebar.jsx` | "News & Notices" link; "Campus pages" group only when published pages exist | Navigation to CMS content |
| `pages/HelpSupportPage.jsx` | Adds "Campus help articles" beside the existing FAQs (renders nothing if none) | Existing Help FAQs untouched |
| `pages/dashboard/StudentDashboard.jsx`, `pages/faculty/FacultyDashboardPage.jsx`, `pages/admin/AdminDashboardPage.jsx` | Item list passed through `applyCmsLayout(items, layout)` | Published layouts; identity when `layout` is null |
| `components/common/widgetSlot.js`, `components/dashboard/SortableDashboard.jsx`, `components/common/WidgetCard.jsx` | Optional `presentation` (title/subtitle override) in the widget slot context | Retitling widgets without touching their data |
| `package.json` / `package-lock.json` | `@puckeditor/core@0.23.0`, `react-markdown@9.0.1`, `@emotion/cache@11.14.0` (exact versions) | Editor, Markdown, editor canvas styles |

### Visual editor

Built on Puck (`@puckeditor/core`). The canvas renders the real React block components in an iframe, so phone (390 px), tablet (820 px) and desktop previews use real breakpoints. It provides a block library, an outline (layers) panel, a properties panel, drag-and-drop reordering, duplicate and delete, undo/redo, and header actions: Save draft, Preview, Publish / Publish changes, Unpublish, Discard unpublished changes, Delete, and Page settings (title, address, summary, audiences, sidebar link, order). Reloading or closing the tab with unsaved changes asks for confirmation. Moving to another page inside the app does not ask yet.

**Blocks** (`shared/cmsBlocks.js`):

- Layout: Section, Row with columns (`1`, `1-1`, `2-1`, `1-2`, `1-1-1`, `1-2-1`), Spacer, Divider.
- Content: Heading, Text (Markdown), Image, Banner, Callout, Info card, Link list, Button (pages only), Contact card.
- Live content: Campus news, FAQs, Academic calendar (from CampusCore via `/sis`).
- Dashboard only: Dashboard widget.

**Page templates** (*Add page*): blank one / two equal / wide + narrow / narrow + wide / three columns; Information page, Campus or portal hub, About an office, Services page, Announcement board, Help and FAQs, Events, Contact page.

### Dashboard layouts

A published dashboard layout is presentation only:

- It can reorder, retitle, re-subtitle, resize or hide widgets, and add content cards (banner, text, callout, news, FAQs, calendar).
- It **cannot add a widget a user is not entitled to.** The layout is applied to the item list the dashboard has already filtered by role, tier entitlements and data availability. A widget the user does not have is skipped.
- Widgets keep their own components, API calls and permission checks.
- Widgets the layout does not mention keep their original position, so widgets added later are never lost. Users can still rearrange their own dashboard.
- Student widgets come from the existing widget definitions; faculty widgets from `shared/facultyWidgets.js`; the admin dashboard's seven sections are `admin.hero`, `admin.communications`, `admin.tiers`, `admin.integrations`, `admin.operations`, `admin.audit` and `admin.sync`.
- *Unpublish* or *Restore built-in layout* returns a dashboard to its original layout immediately.

## 6. Running locally without port conflicts

The experimental prototype project uses ports 1337, 5001, 5173, 5174 and 5002. The CMS uses **1338** and database port **5438**.

1. Start the DBngin server **feddrick-strapi** (PostgreSQL 18, port 5438).
2. Start the CMS:
   ```
   cd feddrick-cms
   npm run develop     # admin at http://localhost:1338/admin
   # production: npm run build && npm run start
   ```
3. Start EduNexusAI as usual. The backend reads `CMS_*` from `edunexus/backend/.env`.
4. Sign in to EduNexusAI as an administrator, open the account menu, choose **Studio**.

If you run the EduNexusAI backend and frontend on non-default ports, add the frontend origin to `CORS_ORIGINS` and point Vite at the backend with `VITE_API_PROXY_TARGET`.

## 7. Tests and verification

Automated (all passing on 2026-10-17):

| Suite | Result | CMS coverage |
|---|---|---|
| EduNexusAI backend `npm test` | 214 / 214 (193 existing + 21 new in `tests/cms.test.js`) | Runs against an in-process stub of the Strapi integration API (`tests/helpers/cmsStub.js`); never contacts the real CMS |
| EduNexusAI frontend `npm test` | 28 / 28 (21 existing + 7 new in `tests/cms.test.mjs`) | Source guard rails and the shared registry |
| Frontend lint (`npm run lint`) | 234 modules clean | |
| Frontend production build | Succeeds; Studio and the editor are separate lazy chunks; no CMS URL or token in the bundle | |

The backend CMS tests cover: ADMIN-only Studio (401 anonymous, 403 student and faculty, refused requests never reach the CMS); the tenant taken from the session even when a client sends another; unknown blocks, `javascript:` links, insecure images, page-only and dashboard-only blocks, invalid slugs and empty audiences all rejected; depth, block-count and unknown-property limits; drafts never delivered; edits to published items not leaking before publish; discard and unpublish; audience filtering for pages, news and FAQs; expired notices hidden; tenant isolation (another tenant's documents give 404 and are left untouched); dashboard layouts (catalogue validation, duplicate widgets, flag off/on, draft not delivered, role check 403, invalid stored layout → built-in, CMS down → built-in, existing dashboard API unaffected); rejected token → 502 without leaking it; media (SVG and type-mismatched content rejected, real PNG accepted and served with `nosniff`, path traversal refused); and EduNexusAI row counts unchanged.

Live verification against the real Strapi (EduNexusAI backend on a spare port against the **test** database, with layouts enabled for that instance only): 25 API checks passed, covering create, publish, edit to "modified", unsafe link rejected, unpublish, audience filtering, nav pages, student dashboard layout publish, delivery and restore, faculty-only news, FAQ draft hidden, image upload and serving, and SVG rejected. Tenant isolation was checked with a document created for another tenant directly in Strapi: GET, publish and delete from Studio all returned 404, and the document was unchanged. With the CMS unreachable, the dashboard layout returned `null`, and `/dashboard` and `/help` returned 200.

In Chrome: the Studio overview, page editor (with real blocks on the canvas), dashboard editor, news editor, a published page as a student (desktop and phone), and the student dashboard with a published layout (CMS banner, retitled widget) all rendered without page errors. Selecting a block in the Outline panel, editing its title in the properties panel and clicking *Save draft* stored the change in Strapi as "modified", while students kept seeing the published version. A student opening `/studio` sees "This area is not available to your role".

All test content created during verification was deleted afterwards (pages, news, help article, dashboard layout, the other-tenant document, and the uploaded image). Strapi's own audit entries for those actions remain, by design.

## 8. Limitations and follow-ups

- **Dashboard layouts flag**: on in the local development `.env` since the second iteration. Any other environment must set `CMS_LAYOUTS_ENABLED=true` itself; without it, dashboards keep their built-in layouts.
- **One layout per persona per tenant.** There is no per-tier or per-department variant yet. Entitlements still apply per user.
- **Media files are public by URL** (as Strapi's `/uploads` are). Do not upload confidential images. Media is listed per tenant, but a file URL is not tenant-checked.
- **No scheduled publishing** and no version history beyond draft/published and the audit log.
- **Unsaved-changes prompt** covers reloading and closing the tab only, not in-app navigation (for example, choosing another rail item).
- **Media deletion** is done in the Strapi admin (Media Library). Studio has no delete button for images.
- **Existing content is not migrated.** The Help Centre FAQs and instructor course announcements stay where they are; CMS help articles and campus news appear alongside them.
- **Editor bundle**: the Studio chunk includes Puck (about 600 KB minified). It loads only for administrators who open Studio.
- **Production**: serve Strapi over HTTPS behind a reverse proxy, use a managed PostgreSQL for `feddrick_cms`, set `CMS_URL` to the internal address, and back up the CMS database and `public/uploads` together.

---

## 9. Second iteration: Studio inside the portal, resizing, live layouts, Student Resources

### 9.1 How Studio opens

- **Account menu → Studio** goes to `/studio`. That route is now a child of the normal portal route (`AppLayout`), so the portal header, logo, account menu and sidebar stay in place. There is no separate dark Studio header any more.
- `AppLayout` detects `/studio/*` for administrators and adds the **Studio rail** (`layouts/StudioRail.jsx`, 84 px) as a flex column to the **left of the existing sidebar**. Both stay visible and the main area reflows; nothing overlaps (checked at 1600 px: rail 0–84, sidebar 84–328, canvas from 344, no horizontal scroll). On phones the rail becomes a horizontal strip under the header.
- Rail items: **Design** (resume editing), **Sites & Pages**, **Widgets** (dashboard layouts), **News**, **Help articles**, **Media**, **Activity**, **Settings** (CMS connection and layouts flag, read-only), and **Exit Studio**.
- Editor routes (`/studio/pages/:id/edit`, `/studio/dashboards/:persona/edit`) use the full main area as the canvas: no breadcrumbs or page padding, and the floating assistant/install dock is hidden while in Studio.
- **Exit Studio** returns to the last portal page visited before entering Studio (kept in `sessionStorage`, internal paths only), or `/dashboard`.

### 9.2 Last editing target

- `pages/studio/studioSession.js` stores the last editor route **per administrator** in `localStorage` (`edunexus.studio.lastTarget.<userId>`). Only editor routes are accepted, and every read is validated against the same pattern.
- `/studio` redirects to that route. Refreshing an editor keeps its URL, so editing continues where it was.
- With no stored target, Studio shows **/studio/start**: the pages list (with *Add page*) and the three dashboards. The same happens if storage is unavailable.
- If the stored page has been deleted, the editor shows "This page no longer exists", forgets the target and links to the start page.

### 9.3 The editor and resizing

Same library (Puck 0.23), new layout: `components/cms/editor/StudioEditor.jsx` composes Puck's own pieces (`Puck.Components`, `Puck.Outline`, `Puck.Preview`, `Puck.Fields`) around a toolbar. Because these are Puck's own pieces, selection, drag-and-drop, history and the saved data are unchanged.

- **Toolbar**: title and address, state chip, Undo / Redo, **Add** (block library: drag a block, or press its **+** to insert it after the selection), **Layers** (outline), phone / tablet / desktop preview widths, Page settings, Preview (saves the draft first), Save draft, Publish / Publish changes, and a menu with View live page, Unpublish, Discard unpublished changes and Delete.
- **Selection**: clicking or hovering a block outlines it. The selected block gets Puck's action bar (select parent, **Move up**, **Move down**, duplicate, delete) and a dashed outline around the visible box.
- **Why it could not resize before**: Puck has no resize handles, and the blocks had no size properties apart from a few presets. Puck also wraps every block in a full-width element, so sizes must be applied to, and measured on, the inner box.

**Resize model (constrained, not freeform).** `components/cms/editor/CmsOverlay.jsx` adds handles to Puck's component overlay. Each handle writes one validated property through Puck's state (`replace`). A drag updates the canvas live and becomes a single undo step when released.

| Handle | Property | Range / step | Notes |
|---|---|---|---|
| Right edge (left edge when the box is right-aligned) | `boxWidth` | 20–100 % of the row, step 5 | Applies from 600 px viewport width up; phones always use 100 % |
| Bottom edge | `heightPx` | 80–1200 px, step 10 (0 = automatic) | Capped at 520 px on phones |
| Divider between columns | `col1Width` … `col4Width` | each ≥ 10 %, total 100 | Rendered as `fr` units; all 0 = use the preset (1-1, 2-1, …) |
| Right edge of a dashboard card | `size` | compact / standard / large | Dashboard grid sizes |

- **Keyboard**: every handle is a focusable button with an `aria-label` that states its value. Arrow keys change the value by one step (5 %, 20 px or 5 % of a column pair). Move up / Move down, duplicate and delete are action-bar buttons, and Delete/Backspace removes the selected block.
- **Properties panel** shows the same values as exact fields: width %, position (left / centre / right), space above and below, height px, image aspect ratio and crop focus, column widths and column layout.
- **Validation** (`shared/cmsBlocks.js`, used by the editor and the server): the new fields are `BOX_LIMITS`, `BOX` (`boxWidth`, `boxAlign`, `spaceAbove`, `spaceBelow`), `heightPx`, `col1Width`–`col4Width` and the root `showTitle`. Out-of-range values are rejected with 400. Box fields are `pageOnly` and are dropped from dashboard layouts. All new fields have defaults, so earlier layouts, including the existing "Academic Information" page and the published student dashboard layout, stay valid unchanged.
- **Rendering**: `BoxFrame` (in `CmsBlocks.jsx`) applies width, position and spacing. The editor canvas and the live page use the same component, so a size set in Studio is the size users see.

New and extended blocks:
- 4-column rows (`1-1-1-1`; 2 × 2 on tablets, stacked on phones).
- Banner: highlighted word, title size, second button, image overlay strength, text width, height, up to 4 stats.
- Info card: "feature" style, optional image, accent colour.
- Link list: "buttons" style with icons.
- Section: subtitle, tint background, optional background image, height.
- Campus news and FAQs: "plain" frame with a section header, subtitle and "view all" link, and polished empty states.
- Heading: subtitle.
- New **Quote / testimonial** block.
- Page option **Show the page title bar** (hero-led pages hide it; the title stays as a visually hidden `h1`).

### 9.4 Dashboard layouts and `CMS_LAYOUTS_ENABLED`

Purpose: a server-side switch that decides whether published Studio dashboard layouts reach users. With it off, or with no published layout, an invalid stored layout or the CMS unavailable, `GET /api/v1/content/dashboard-layouts/:persona` returns `layout: null`, and `applyCmsLayout` leaves the dashboard's own item list untouched.

Verified before enabling (backend on a spare port against the test database, flag on):
- The **Faculty** and **Admin** dashboards showed a temporary published layout: an added card, a retitled widget and a hidden widget.
- The **Student** dashboard showed the layout already published in Studio.
- Every widget still called its usual authorised API (`/faculty/dashboard`, `/admin/dashboard`, `/admin/audit`, `/finance`, `/lms/me/moodle/assignments`, `/courses`, …).
- Cross-role layout requests returned 403 (student → faculty, faculty → admin, faculty → student).
- The temporary Faculty and Admin layouts were deleted afterwards.

Activation: `CMS_LAYOUTS_ENABLED=true` was then set in `edunexus/backend/.env`, and the running development backend (`node --watch`) was restarted by touching `src/config/env.js`. Studio Settings shows the flag's state. To switch it off, set it to `false` and restart the backend.

**Note:** the student dashboard layout already published in Studio is now live. It retitles the schedule widget to "kjkj", which looks like test text. Edit or unpublish it in **Studio → Widgets → Student dashboard**.

### 9.5 Student Resources — Feddrick University

- Created through the Studio API, the same validated save path the editor uses (`POST /api/v1/studio/page`, then `…/publish`). It is not a React page. It is fully editable in Studio: `/studio/pages/nuox4dp58s49rcvbdm25r3j1/edit`.
- Address `/pages/student-resources`; audience: students and staff (administrators); shown in the sidebar under *Campus pages → Student Resources*; root width "wide"; title bar hidden (hero-led).
- **Hero image**: the existing Strapi Media Library asset **`herobackground.png`** (media id 4, 2048 × 768), found by exact name through `GET /api/v1/studio/media`. Exactly one match was required; its stored reference `/api/v1/content/media/herobackground_474609bb68.png` is used. No upload or duplicate was made. The same asset is reused in the Quote block.
- Sections:
  1. Hero banner: eyebrow, headline with "Thrive" highlighted, text, "Explore Resources" → `/help/resources`, "Get Student Support" → `/help`, and three descriptive highlights (no invented statistics).
  2. "Your Campus Toolkit": four feature cards linking to `/academics`, `/academics/calendar`, `/career` and `/help`.
  3. "Latest Announcements": the live campus news block, plain frame, cards, "View all" → `/campus/news`.
  4. "Need a little help?": a tinted section with a button to `/help` and links to `/academics/advising`, `/financial-aid`, `/help/tickets` and `/help`.
  5. "Frequently Asked Questions": the live help-articles block, beside the quote.
- No announcements or help articles are published yet, so those two sections show their empty states. Nothing is hard-coded. Content published under News or Help articles appears there automatically for students.
- Verified: students get the page (desktop and 390 px phone, no horizontal overflow); faculty get 404 from the API and "not available" in the portal.

### 9.6 Files changed in this iteration

| File | Change |
|---|---|
| `shared/cmsBlocks.js` | Box size, position and spacing fields with limits; column ratios and 4-column rows; extended Banner, InfoCard, LinkList, Section, Heading, news and FAQ blocks; Quote block; root `showTitle`; page-only fields dropped in dashboards |
| `frontend/src/components/cms/blocks/CmsBlocks.jsx` | `BoxFrame`, `heightSx`, column templates, the new block options and Quote |
| `frontend/src/components/cms/puckConfig.jsx` | Page blocks render in `BoxFrame`; dashboard cards show their size; root `showTitle` field |
| `frontend/src/components/cms/editor/StudioEditor.jsx` (new) | Editor layout and toolbar inside the portal |
| `frontend/src/components/cms/editor/CmsOverlay.jsx` (new) | Resize handles, keyboard resizing, Move up / Move down |
| `frontend/src/layouts/StudioRail.jsx` (new), `layouts/AppLayout.jsx` | Studio rail beside the sidebar; full-bleed editor routes; return path |
| `frontend/src/App.jsx` | `/studio/*` moved inside the protected portal shell (still ADMIN-only) |
| `frontend/src/pages/studio/StudioApp.jsx`, `studioSession.js` (new) | Resume last target, start page, Activity, Settings; no standalone shell |
| `frontend/src/pages/studio/StudioPageEditor.jsx`, `StudioDashboards.jsx`, `StudioPreview.jsx` | Use the new editor; remember target; preview inside the shell |
| `frontend/src/pages/cms/CmsPage.jsx` | Honours "Show the page title bar" |
| `frontend/tests/cms.test.mjs`, `backend/tests/cms.test.js` | New tests (below) |
| `backend/.env` (git-ignored) | `CMS_LAYOUTS_ENABLED=true` |

Unchanged: the backend CMS routes, services and client, Strapi (no schema or controller change), SIS/LMS connectors, authentication, and the EduNexusAI database (still 83 tables, 34 users, 12 migrations).

### 9.7 Tests in this iteration

| Check | Result |
|---|---|
| Backend `npm test` | **215 / 215** (adds server validation of box sizes, column ratios and `showTitle`) |
| Frontend `npm test` | **33 / 33** (adds: existing layouts stay valid, out-of-range sizes rejected, page-only fields dropped in dashboards, handles write validated props, resume-target validation and protocol-relative return paths rejected) |
| Lint / production build | 238 modules clean / build succeeds |
| Chrome, admin | `/studio` with no history → `/studio/start`; after editing → back in that editor. Rail left of the sidebar, no overlap. Image width drag 100 % → 50 % (872 → 436 px), keyboard +2 steps → 60 %, height drag → 320 px, column divider → 73 / 27, undo restores 50 / 50 and redo returns 73 / 27, Save draft stores `boxWidth 60, heightPx 320, col1Width 73, col2Width 27`, and a reload renders the same sizes. Exit Studio → previous portal page. No page errors. |
| Chrome, student | Student Resources renders through the CMS with the real hero asset; sidebar entry present; phone width without overflow. |
| Dashboards | Section 9.4 |

Test content (a resize test page and temporary Faculty and Admin layouts) was deleted. Remaining CMS content: the user's "Academic Information" page, Student Resources, the user's published student layout, and the three existing images.

### 9.8 Remaining limitations

- Resizing is constrained by design (percent widths in 5 % steps, pixel heights, column ratios), not pixel-free positioning. It keeps pages responsive and valid on every screen.
- Dashboard widgets show on the Studio canvas as labelled stand-ins, because their data belongs to each signed-in user and is never loaded for the editor. Their size, order, title and visibility are edited for real.
- The Studio rail and editor are designed for tablet and desktop. On phones the rail is a strip and editing is cramped.
- The last editing target is stored per browser, not per account across devices.

---

## 10. Third iteration: edit the page being viewed, independent scrolling

### 10.1 Root causes

**Scrolling.** In editor mode the portal's `main` element was `flex: 1` inside a column whose height was not bounded (the shell only had `min-height: 100vh`). Puck also wraps our editor layout in its own root element (`.Puck`, `height: auto`), so the `height: 100%` chain below it resolved to "content height". The whole editor therefore grew to the height of its tallest panel: the properties panel for a Banner measured 2,755 px against an 860 px window. The browser window scrolled (`scrollY` 600) instead of the panel (`scrollTop` 0).

**Route.** The separate `/studio/pages/:id/edit` route was a routing choice, not a page-builder limit. Live pages (`/pages/:slug`) and the editor already use the same block registry and components, and Puck can run inside any route. The reference product keeps the page URL and adds edit controls on top; our earlier design sent the administrator to a different URL for a separate view of the same page.

### 10.2 What changed

**Studio is an edit mode, not a destination.**
- `pages/studio/studioMode.jsx` holds `editing` per browser tab (`sessionStorage`). A refresh keeps editing; a new tab opens in the normal view. It is only ever on for administrators: `editing = isAdmin && on`, so a student or faculty member who sets the flag by hand still gets nothing.
- **Account menu → Studio** switches edit mode on without navigating. While editing, the same item reads **Exit Studio**.
- `AppLayout` maps the current route to an editor with `editableTarget(pathname)`, and renders the editor in place of the route's normal view. The URL, query string and browser history are unchanged:

| Route | Editor |
|---|---|
| `/pages/:slug` | That Studio page (draft or published; resolved by address within the session tenant) |
| `/dashboard`, `/admin` | Admin dashboard layout (what an administrator sees on those routes) |
| `/faculty` | Faculty dashboard layout |
| Anything else | No editor. A notice says the page is built from live application data and cannot be edited, with "Studio pages" and "Exit Studio" buttons. The page stays as it is, with no switch to another page. |

- **Student dashboard**: no route shows it to an administrator, so it keeps the dedicated editor at `/studio/dashboards/student/edit`.
- **Older links**: `/studio/pages/:id/edit` (pages list, Add page, bookmarks) now switches edit mode on and replaces the URL with `/pages/<slug>`. `/studio/dashboards/faculty|admin/edit` goes to `/faculty` and `/admin`.
- **Never creates anything**: if no Studio page exists at `/pages/:slug`, the editor says so instead of creating one, and switching Studio on never creates a page or layout.
- **Rail**: *Design* is active while editing a page and resumes the last edited page from `/studio`. *Exit Studio* leaves edit mode and stays on the current page, or returns to the last portal page when used from a Studio list page.
- **Unsaved changes**: Exit Studio asks before discarding them. While an in-place editor has unsaved changes, clicking a portal link asks before leaving, because the editor would unmount.
- **Resume target**: the last edited target is now the portal route itself (`/pages/:slug`, `/faculty`, `/admin`, `/dashboard`) or the Student dashboard editor route.

**Scrolling fix (no fixed heights).**
- While an editor is shown, the shell is bounded to the viewport (`height: 100vh; overflow: hidden`) and every flex level below it has `min-height: 0`.
- `StudioEditor` bounds Puck's root (`.Puck { height: 100% }`).
- The canvas box is `overflow: hidden`, and the iframe inside it scrolls the page.
- The block library, layers and properties panels each have `overflow-y: auto` and `overscroll-behavior: contain`, so reaching the end of a panel does not scroll anything else.
- Outside the editor the portal layout is unchanged.

### 10.3 Files changed

| File | Change |
|---|---|
| `frontend/src/pages/studio/studioMode.jsx` (new) | Edit-mode context, route → editor mapping, unsaved-changes guard |
| `frontend/src/pages/studio/InPlaceEditor.jsx` (new) | Resolves the current route to its saved page or dashboard and opens the existing editor |
| `frontend/src/layouts/AppLayout.jsx` | Provider; editor in place of the route view; non-editable notice; viewport-bounded shell while editing |
| `frontend/src/layouts/Header.jsx` | Studio menu item toggles edit mode instead of navigating |
| `frontend/src/layouts/StudioRail.jsx` | Design / Exit behaviour for edit mode |
| `frontend/src/components/cms/editor/StudioEditor.jsx` | Bounded Puck root; independent, contained panel scrolling |
| `frontend/src/pages/studio/StudioPageEditor.jsx` | `PageEditor({ id })` reused in place; the old route redirects to `/pages/<slug>` |
| `frontend/src/pages/studio/StudioDashboards.jsx` | `DashboardEditor({ persona })` reused in place; Faculty/Admin routes redirect to their live routes |
| `frontend/src/pages/studio/StudioApp.jsx`, `studioSession.js` | Resume enters edit mode on the remembered portal route |
| `frontend/tests/cms.test.mjs` | Tests for the above |

Unchanged: backend, Strapi, the block registry, save/publish/unpublish flows, dashboard rendering and widget data, authentication and the database.

### 10.4 Verification (2026-10-17)

Run in Chrome against a backend on a spare port using the test database and the real Strapi: **17 / 17 checks passed**.

- **Entering Studio on a page**:
  - Account menu → Studio on `/pages/student-resources?ref=nav` showed the editor for that page with the URL (including the query) unchanged.
  - The editor fills the viewport (document height = window height).
  - Wheel over the properties panel: panel `scrollTop` 900, window `scrollY` 0, header still at the top. Wheeling past the end of the panel left the page in place.
  - Wheel over the canvas: canvas scrolled 824 px; window and panels did not move.
  - The rail stayed visible.
- **Editing in place** (on a disposable draft page, `/pages/cms-verify-inplace`):
  - Changed a Heading's text in the properties panel and used **Move down** on the action bar, then Save draft. The stored layout had the new order and text.
  - After a reload the page was still in edit mode at the same URL, with the saved order.
  - Students got 404 for the draft.
- **Exit Studio** restored the normal view at the same URL, with no rail or editor.
- **Other routes**:
  - `/faculty` opened the Faculty dashboard editor in place, and `/admin` the Admin dashboard editor.
  - `/help` showed the "can't be edited" notice over the normal Help page, with no editor and no redirect.
- **Students**:
  - The Studio menu item is absent, and a hand-set edit flag is ignored.
  - `/pages/student-resources` shows the published page.
  - The Studio API returns 403.
- **Smaller screens**: at 1280, 1024 and 900 px wide there is no horizontal or vertical page overflow, and Publish stays visible.
- **Automated**: frontend 36 / 36, backend 215 / 215, lint clean (240 modules), production build succeeds (the in-place editor is its own lazy chunk).
- **Cleanup**: the disposable page was deleted. CMS content afterwards is the "Academic Information" page, Student Resources and the user's published student layout. The EduNexusAI database is unchanged (83 tables, 34 users, 12 migrations).

**Incident during verification:** stopping the verification server with `pkill -f "node --watch src/server.js" -P <pid>` also stopped the developer's own EduNexusAI backend (port 5001). macOS `pkill` stops reading options at the pattern, so the `-P` filter was ignored. No data was affected. The server was restarted with `npm run dev` from `edunexus/backend`; its output now goes to `backend/.dev-server.log` (git-ignored) instead of the original terminal.

### 10.5 Limitations

- Dashboard widgets are still labelled stand-ins on the canvas, because their data belongs to each signed-in user. Their order, size, title and visibility are edited for real; the live dashboards keep loading real data.
- The canvas is the page-builder render of the page, not the surrounding portal chrome: a page's title bar is shown by the normal view, not inside the canvas.
- In-app navigation away from unsaved changes is guarded for portal links (`<a>`); browser back/forward is not intercepted (the app uses `BrowserRouter`, which has no navigation blocker).

---

## 11. The Admin dashboard, editable with its real components

### 11.1 Investigation and root cause

Before this change:
- **Page** (`pages/admin/AdminDashboardPage.jsx`): one `GET /api/v1/admin/dashboard` (tenant, counts, tiers, integration health, recent sync log), plus URL-driven Operations tab state (`?ops=`) and an audit refresh key.
- **Sections**: seven sections, written inline in the page:

| Section | Content | Data |
|---|---|---|
| `admin.hero` | `HeroBanner` + `HeroStats` | counts |
| `admin.communications` | 8/4 grid: `AdminCommunicationAnalyticsWidget`, then `AdminEmergencyBroadcastWidget` and the Campus operations card | `/admin/broadcasts` |
| `admin.tiers` | Student tiers card | tiers |
| `admin.integrations` | Integration health table | integration health |
| `admin.operations` | Operations workspace tabs: approvals, help desk, forms, resources, interventions | each widget's own `/admin/...` calls; changes refresh the dashboard and audit |
| `admin.audit` | `AdminAuditActivityWidget` | `/admin/audit` |
| `admin.sync` | Recent integration activity | sync log |

- **Layout**: a vertical `Stack` (spacing 2 / 2.25) inside the portal's content area; the communications row uses the 12-column `DashboardGrid` internally.
- **Access**: `RoleRoute ADMIN`; the backend checks every call.

Why Studio showed generic cards:
1. The dashboard editor rendered every *Dashboard widget* block as a `WidgetPlaceholder` by design, because widget data belongs to each signed-in user.
2. The canvas root was a plain vertical list, and each block was wrapped in a bordered frame.
3. The sections' JSX and their single data query lived inside `AdminDashboardPage`, so nothing outside the page could render them.

There was also a latent bug: a title override on `admin.communications` would have retitled all three of its cards, and the hero ignored overrides.

### 11.2 Approach: one implementation, two hosts

- **`components/admin/adminDashboardSections.jsx`** (new):
  - The section JSX, moved from the page **unchanged** (same components, props, handlers, links and styles).
  - `useAdminDashboardModel()`: the same single `adminApi.getDashboard()` query, `?ops=` tab state and audit refresh key as before, created once.
  - `AdminDashboardModelProvider` and `AdminDashboardSection({ sectionKey, presentation })`.
  - A Studio title/subtitle override is applied only to that section's own heading: the hero (title / eyebrow), the analytics card only (not its neighbours), tiers, integrations, the Operations heading and description, audit, and sync.
- **`AdminDashboardPage`**:
  - Builds the model once and renders `AdminDashboardSections`.
  - With no published layout (flag off, CMS down, invalid layout) this is the original `Stack`.
  - With a layout, sections go in a 12-column grid at their Studio widths: original/large = 12 columns, standard = 6, compact = 4, and phones are always full width. Full-width sections in that grid render identically to the stack.
- **Studio** (`StudioDashboards.jsx`, `puckConfig.jsx`):
  - The **admin** editor wraps the canvas in the same model provider and passes a `live` renderer, so each *Dashboard widget* block renders the real `AdminDashboardSection`.
  - Content blocks render as on the live page. The canvas root uses the live dashboard's 12-column grid and spacing, with each block placed by its `data-span`.
  - Student and Faculty editors are unchanged (stand-ins).
- **Canvas fidelity** (`StudioEditor.jsx`): the canvas renders at a logical width (desktop 1200 px, close to the live content width; tablet 820; phone 390) and is scaled to fit with a CSS transform, as Puck's own canvas does. So the dashboard keeps its desktop layout, including the 8/4 communications row, even with the rail, sidebar and properties panel open.
- **Interactions inside the canvas**: Puck sets `pointer-events: none` inside blocks in edit mode. Selecting a card therefore never triggers its buttons, tabs, links or dialogs. They are unchanged on the live page.
- **Data**: layouts store only presentation (order, visibility, size, title/subtitle and content cards), never data. The editor and live page make the same requests; the canvas adds only Studio's own layout calls.

Editing capabilities for the Admin dashboard:
- Select a section (canvas or Layers; the properties panel shows the section's name).
- Reorder (drag, or Move up / Move down).
- Hide or re-add sections, and add content cards.
- Edit the title and subtitle.
- Resize with the edge handle or keyboard (original / compact / standard / large); two narrower sections can sit side by side.
- Save draft, Preview (the editor's phone/tablet/desktop widths), Publish, Unpublish, Discard, and Restore built-in layout.

The *internals* of a section (for example the communications row's 8/4 split or the Operations tabs) are not editable. They are kept exactly as built.

### 11.3 Files changed

| File | Change |
|---|---|
| `frontend/src/components/admin/adminDashboardSections.jsx` (new) | The sections (original JSX), the data/interaction model, scoped title overrides |
| `frontend/src/pages/admin/AdminDashboardPage.jsx` | Uses the shared model and sections; original stack without a layout, 12-column grid with one |
| `frontend/src/pages/studio/StudioDashboards.jsx` | Admin editor renders the real sections around the same model; others unchanged |
| `frontend/src/components/cms/puckConfig.jsx` | Optional `live` renderer and grid root for dashboards (admin only) |
| `frontend/src/components/cms/editor/StudioEditor.jsx` | Canvas at logical width, scaled to fit; section name in the properties header |
| `frontend/src/components/cms/editor/CmsOverlay.jsx` | Card-size handle measures against the whole grid row |
| `frontend/tests/cms.test.mjs` | Tests for the shared implementation |

Unchanged: the admin widgets themselves, API services and endpoints, backend, Strapi, block registry, authentication, Student and Faculty dashboards, the other admin pages, and the database.

### 11.4 Verification (2026-10-17; backend on a spare port against the test database, real Strapi)

| Check | Result |
|---|---|
| Normal `/admin` before vs after the refactor (1440 × 900) | Full-page screenshot **byte-identical**; section positions identical; the same dashboard API calls (each made twice, as before, because of React StrictMode in development); no page errors |
| Fallbacks: `CMS_LAYOUTS_ENABLED=false` and CMS unreachable | Backend returned `layout: null` (and `unavailable: true`); both renders pixel-identical to each other and to the published-layout render (with fonts loaded) |
| Studio canvas | Real sections and data, no stand-ins; communications keeps its 8/4 layout (canvas at 1200 px, scaled 0.77) |
| Select / edit / resize / reorder | Selected "Student tiers"; title edit rendered on the real card; drag handle → `standard` (6 of 12 columns, 567 of 1152 px); Move up placed it second |
| Save draft | Stored order, title and size; state "modified"; live API and normal `/admin` still showed the published version; reload kept the draft in the editor |
| Publish | Live layout updated; normal `/admin` showed the new title at half width; dashboard API calls unchanged, no Studio calls |
| Interactions on live `/admin` | Operations tab → `?ops=support`; "Manage integrations" → `/admin/integrations`; a request row opened its detail dialog; "Prepare urgent notice" → `/notifications?urgent=1` |
| Regression | `/admin/users`, `/admin/integrations`, admin `/faculty` (normal and Studio, still stand-ins), Student dashboard editor route, faculty `/faculty`, student `/dashboard`: all render with no errors; students are refused at `/admin` |
| Automated | Frontend 39 / 39, backend 215 / 215, lint clean (241 modules), production build OK |

The administrator's existing published Admin layout (all seven sections, original order and sizes) was backed up before testing. It was changed by the save/publish tests, then restored and republished. It is the same document with identical content (an order-insensitive comparison of the JSON). The EduNexusAI database is unchanged (83 tables, 34 users, 12 migrations).

### 11.5 Limitations and risks

- Section internals (the communications row split, the Operations tabs, the table columns) are fixed. Only whole sections are arranged and sized.
- The Layers panel lists every section as "Dashboard widget"; the canvas selection and the properties panel show which section it is.
- In the canvas, a section's buttons and tabs are inactive while editing (Puck's edit mode). Use *Open normal view* to interact.
- `CMS_LAYOUTS_ENABLED` was already on (since the second iteration) and still applies to all three dashboards; this task did not change it.

---

## 12. UI refinements (2026-10-18)

### 12.1 Sites & Pages panel and the Add page dialog
- **Sites & Pages** in the Studio rail no longer navigates. It toggles a 300 px panel to the right of the rail, laid over the edge of the portal sidebar, so the page stays where it is. It contains **Create Page**, **Manage Pages** (`/studio/pages`) and **View Templates**. Escape, clicking outside, or clicking the rail item again closes it. Its first option takes focus.
- **Add page** (`pages/studio/AddPageDialog.jsx`, new; replaces the dialog formerly in `StudioPagesList.jsx`) is a two-column dialog:
  - **Left**: *Pre-built templates* and *Blank page layouts* as selectable tiles (radio semantics, visible selected state).
  - **Right**: a live preview of the selected option. It uses the same blocks as the editor and the portal, rendered at 1200 px and scaled to fit; it is not interactive. Below it, the page details (title, address, summary, audience, sidebar).
  - Create Page and Cancel. *Create Page* and *View Templates* both open this dialog.
- **Templates** (`components/cms/templates.js`):
  - Dashboard (the former hub), **Link page** (new), About us, Our services, **Our team** (new), Contact us, **Image gallery** (new), News board, Help & FAQs, Events and Information.
  - Blank layouts: 1 column, 2 columns, **2 columns 70/30** and **2 columns 30/70** (exact column widths), and 3 columns.
  - Existing template keys are unchanged.
  - The About us template's button now points to the real `/academics/advising` route (it pointed to `/advising`, which does not exist).
  - There is no *Saved templates* section, because saved templates are not supported.
- **Creating**: the dialog creates a draft with the selected template's layout, then opens it in the editor in place (`/pages/<address>`). A ref blocks repeat submits, and the server's unique-address rule (409) prevents duplicates.

### 12.2 Studio rail logo
`edunexus/frontend/public/logo_icon.png` (found in the repository, 1254 × 1254) is shown at 36 × 36 px, centred at the top of the rail, above a divider (21 px clear of the first item). It replaces the "STUDIO" text. The university logo in the portal sidebar is unchanged.

### 12.3 Portal Appearance themes
- Added **Royal Purple & White** (`royal-purple`, primary `#704D93`; white text on it has a contrast ratio of about 6.6:1) to the shared presets (`shared/appearancePresets.js`). It is a complete palette, like the other themes: navigation, surfaces, text, accents and glows.
- **Indigo & Light Gray** (`indigo-gray`), the only preset named Indigo/Gray, moved to `RETIRED_THEMES`:
  - It is not offered, and the API no longer accepts it for new saves.
  - A tenant that already saved it keeps rendering with it (`findTheme` and the frontend's `RENDERABLE_THEME_KEYS`). The Appearance page then explains that the theme is retired and requires choosing a current one before saving.
  - No stored setting was changed. Unknown keys still fall back to the default.

### 12.4 Admin dashboard: space under Campus operations
Root cause: the right-hand grid cell of the communications row stretches to the analytics panel's height, but its two cards kept their content heights, so the leftover space collected under Campus operations. Now both cards grow (`flex: 1 1 auto`, from `md` up): each keeps its content height plus an equal share of the slack, and the column ends level with the panel. Phones (stacked) are unchanged. No content was added.

### 12.5 Density and navigation typography
Measured: the content looked better at Chrome's 90% zoom, but navigation labels (13 px) dropped to 11.7 px there. Changes, made through existing tokens (no `zoom`, no `transform`):

| Token / component | Before | After |
|---|---|---|
| h1 / h2 / h3 / h4 / h5 / h6 | 32 / 26 / 24 / 20 / 17 / 15 px | 30 / 24 / 22 / 19 / 16 / 14.5 px |
| subtitle1, body1, body2 | 14.5, 14, 13 px | 14, 13.5, 12.5 px |
| metric (stat values) | 28 px | 25 px |
| Hero title (lg) / dense hero padding | 31 px / 16 px | 28 px / 14 px |
| Widget card header / body padding (sm+) | 18 px | 16 px |
| Page gutters (lg) / top padding | 24 / 16 px | 20 / 14 px |
| Header height | 58 px | 54 px |
| **Sidebar labels** (now independent of body2) | 13 px | **14 px** (sub-items 13.5 px) |
| **Studio rail labels** | 10.9 px | **12 px** |

At 100% zoom the Admin dashboard now has close to the density of the old 90% view, with larger navigation text. Assumption: a standard (non-scaled) operating-system display. The comparisons were made at 1440 × 900 CSS px.

### 12.6 Files changed
`shared/appearancePresets.js`; `frontend/src/context/AppearanceContext.jsx`; `frontend/src/pages/admin/AdminAppearancePage.jsx`; `frontend/src/layouts/StudioRail.jsx`; `frontend/src/pages/studio/AddPageDialog.jsx` (new); `frontend/src/pages/studio/StudioPagesList.jsx`; `frontend/src/components/cms/templates.js`; `frontend/src/components/admin/adminDashboardSections.jsx`; `frontend/src/theme/theme.js`; `frontend/src/components/dashboard/HeroBanner.jsx`; `frontend/src/components/common/WidgetCard.jsx`; `frontend/src/layouts/AppLayout.jsx`; `frontend/src/layouts/Sidebar.jsx`; `frontend/tests/cms.test.mjs`. No backend code, API contract, database or Strapi change. The backend validates themes through the shared preset list.

### 12.7 Verification (verification backend on the test database, real Strapi, Chrome)
- **Rail and panel**:
  - The logo loads, centred, 21 px above the first item.
  - Sites & Pages opens the panel without navigating; it closes on a second click and on Escape.
  - Manage Pages → `/studio/pages`; View Templates and Create Page → the dialog.
- **Dialog**:
  - 16 options shown (11 templates, 5 blank layouts); selecting updates the preview (Our team showed its cards; 70/30 measured 357/153 px).
  - Creating "Our team" with a double-click produced **one** page, opened in place in the editor; it was still there after a reload.
  - A 30/70 blank page saved `col1Width 30, col2Width 70`.
  - Test pages were deleted.
- **Themes**:
  - Royal Purple offered and Indigo & Light Gray not; saved, then applied after a reload (`--enx-primary #704D93`, purple navigation).
  - The test tenant's original theme (teal, collegiate serif) was restored afterwards.
  - A simulated stored `indigo-gray` (intercepted API response, no database change) rendered with its palette, showed the retired-theme notice, and could not be re-saved.
- **Admin dashboard**: the right column now ends level with the analytics panel.
- **Widths** (1440, 1280, 1024 and 390 px, on the Admin dashboard, the in-place editor, Studio pages and the Student dashboard): no horizontal overflow, no clipped rail labels, no page errors.
- **Regression**: the in-place editing and scrolling suite (17 / 17) passed again.
- **Automated**: frontend 39 → **43 / 43**, backend **215 / 215**, lint clean (242 modules), production build OK. The dialog is its own lazy chunk; the main bundle grew by about 9 KB.
- **Unchanged**: the EduNexusAI database (83 tables, 34 users, 12 migrations; tenant theme `navy-white`), the CMS (your two pages), and your running servers.

### 12.8 Limitations
- "Communication Center" plus its unread badge is still truncated in the 244 px sidebar, as it was before.
- Typography sizes are global tokens, so every page is slightly denser. Pages were spot-checked (Admin, Student and Faculty dashboards, Help, Appearance, Studio), not every route.

---

## 13. Scheduled publishing, Visual/Source rich text, custom forms and video (2026-10-18)

### 13.1 Decisions

| Area | Decision | Why |
|---|---|---|
| Scheduling | Jobs live in the CMS: new `publication-schedule` collection, executed by a **Strapi cron task** every 20 s (`config/cron-tasks.js` → `api::edunexus.scheduler`) | Content and its publication state live in Strapi; jobs run with no browser open, survive EduNexusAI restarts, and catch up after a CMS restart |
| Where the controls are | One **Schedule** dialog, opened from the page editor (⋮ → *Schedule publishing…*, with the schedule shown under the page title), **Manage Pages** (row *Schedule* button, Scheduled filter) and the **News / Help article** editors (*Schedule…*) | The same form everywhere, next to the existing Publish actions. It is not in *Add page*, because a new page holds template placeholders and is not ready to schedule |
| Timezone | The institution's timezone (`tenants.timezone`, `America/New_York`), shown in the dialog. Times are converted to UTC instants (DST handled: skipped times move forward, repeated times use the first occurrence) | An existing setting; the server stores exact instants |
| Rich text | **TipTap 3.32.0** (already installed as part of Puck; now declared at that exact version) with a Visual mode and an HTML Source mode. Server sanitizing with **sanitize-html 2.18.0**. Portal rendering builds React elements from an inert parse (no `dangerouslySetInnerHTML`) | Puck's own rich-text field renders stored HTML with `dangerouslySetInnerHTML` and has no source mode |
| Forms | New `form` type (draft and publish), managed under a new **Studio → Forms** rail item and placed on pages with the **Form** block | Forms are reusable across pages, so they are managed separately from pages |
| Email | **SMTP via nodemailer 10.0.13** in the EduNexusAI backend | No mail provider existed; SMTP works with any institutional mail service |
| Video | **Video** block: stores a YouTube/Vimeo URL; the embed address is built from the parsed id on `www.youtube-nocookie.com` / `player.vimeo.com` | No iframe HTML or arbitrary domains are accepted |
| CSP | **No change.** The frontend is served without a CSP, and the API's Helmet CSP applies only to API responses | If you deploy the portal with a CSP, add only `frame-src https://www.youtube-nocookie.com https://player.vimeo.com` |

### 13.2 Scheduled publishing

- **Data** (CMS only): `publication_schedules` (tenant, contentType, targetId, action publish/unpublish, runAt, status pending/running/done/cancelled/failed/blocked, draftFingerprint, attempts, nextAttemptAt, lastError, executedAt, actor).
- **API**: `GET/PUT /api/edunexus/content/:type/:documentId/schedule` (new token actions `scheduleGet`, `scheduleSet`) and `GET/PUT /api/v1/studio/:type/:id/schedule` (ADMIN, session tenant). In the PUT body, an ISO time sets the schedule, `null` cancels it, and an absent key leaves it unchanged.
- **Validation (CMS and dialog)**:
  - Times must be at least a minute in the future.
  - Unpublish must come after publish.
  - Unpublish alone is refused for an item that has never been published.
  - A publish cannot be scheduled while the draft has unsaved edits (dialog).
- **Reliability**:
  - Each job is claimed atomically (pending → running in one conditional update), so it can't run twice.
  - Failures are retried at 1, 2, 4 and 8 minutes, then marked *failed* with the error.
  - A job left *running* by a crash returns to pending after 5 minutes.
  - Unpublishing something already unpublished counts as done.
- **Version safety**: a scheduled publish records the draft version it was confirmed for. Saving the draft afterwards immediately marks it **blocked** ("Publish paused: draft changed"), and the job never publishes unreviewed changes; confirming the schedule in the dialog re-arms it. Publishing manually cancels a pending publish; unpublishing manually cancels both.
- **Delivery**:
  - A scheduled item is a draft until the job runs, so it can't be seen early.
  - As soon as an unpublish time passes, delivery hides the item even before the job runs.
  - Audience and tenant rules are unchanged (the job only publishes; delivery filters as before).
- **States**: Draft, **Scheduled** (draft with a pending publish), Published, Published · unpublished changes. Lists and toolbars show "Publishes …" / "Unpublishes …" / "Publish paused".
- **Scope**: pages, news (announcements) and help articles. Announcements keep their separate `expiresAt` as well.

### 13.3 Visual / Source rich text

- **Where**:
  - Page *Text* blocks: new blocks use rich text; existing blocks keep Markdown until switched, and switching converts automatically.
  - News bodies and help-article answers (`bodyFormat` / `answerFormat` = `markdown` | `html`). Existing items stay Markdown, with a "Switch to the rich-text editor" button.
- **Visual mode**: paragraphs and headings 2–4, bold, italic, underline, strikethrough, bulleted and numbered lists, quotes, links (validated), images (media library or https), divider line, alignment, clear formatting, undo/redo.
- **Source mode**: editable HTML. Visual and Source share one value, so switching never drops unsaved text. Moving from Source to Visual lists malformed markup and anything the policy will remove, and asks before continuing.
- **Policy** (`shared/richHtml.js`):
  - Allowed tags: `p br strong em u s h2 h3 h4 ul ol li blockquote a img hr code pre`.
  - Links: `href` limited to https/http/mailto/tel or a portal path; `target=_blank` gets `rel="noopener noreferrer"`.
  - Images: media-library or https `src`.
  - Styles: `text-align` only.
  - Everything else is removed (scripts, iframes, styles, classes, event handlers, svg, forms).
  - Applied by the backend on save and again on delivery. The portal renderer applies the same allowlist when it rebuilds the HTML as React elements.

### 13.4 Custom forms

- **CMS type `form`** (draft and publish): name, description, fields (JSON), submit label, success message, `recipientEmail` (private), notification subject, audiences.
- **Field types**:
  - single-line text, email, multi-line text, phone, number (min/max), date;
  - dropdown, radio buttons, checkboxes (any), single yes/no checkbox.
  - Each field has a label, a machine name, a placeholder, help text, required, a maximum length and options.
  - Validation lives in `shared/forms.js`: the server uses it, and the browser uses it for instant feedback.
- **Studio → Forms**:
  - The list offers New, Duplicate and Edit.
  - The editor has a **Fields** tab (add, select, edit, move up/down, delete, typed options), a **Settings & notifications** tab (recipient with validation, an optional domain policy, subject, audiences, live mail status) and a **Preview & test** tab. The test runs the server's validation against the saved draft and sends nothing.
  - Save draft, Publish / Publish changes, Unpublish, Discard and Delete are available. Pages always use the **published** form.
- **Embedding**: the page-builder **Form** block (Live content group) chooses a form from a list. On the canvas it shows the draft, inert; on previews and portal pages it loads the published form.
- **Submission** (`POST /api/v1/content/forms/:id/submissions`, signed-in users):
  1. The published definition is loaded from the CMS (session tenant, form audience). Otherwise the response is 404.
  2. A filled hidden "website" field means a bot: the reply looks accepted and nothing is sent.
  3. The values are validated against the definition. Unknown fields, extra keys, out-of-list values and lengths are rejected with 400 and per-field messages.
  4. If no recipient is set the response is 503 `FORM_NOT_CONFIGURED`; if SMTP isn't configured it is 503 `MAIL_NOT_CONFIGURED`. Nothing is claimed sent in either case.
  5. The email goes to the recipient, with a plain-text and an escaped-HTML part, `Reply-To` set to the submitter's email field, and the submitter's name, portal email and role. A mail failure returns 502 `MAIL_FAILED`.
- **Limits and privacy**:
  - 10 submissions a minute and 30 an hour per user, plus a 40 KB body cap.
  - Submissions are **not stored**. Logs record only the form id and the outcome.
  - SMTP settings are never sent to the browser; Studio sees only configured / verified / problems.
- **Configuration** (`edunexus/backend/.env`, see `.env.example`): `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` (or `SMTP_URL`), `MAIL_FROM`, and optionally `FORM_RECIPIENT_DOMAINS`. Restart the backend afterwards. **Not configured yet in this environment** (no provider credentials were available), so live submissions are currently refused with a clear message.

### 13.5 Video embed

`shared/video.js`:
- **Accepted addresses**: `youtube.com/watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, `/live/`, `youtube-nocookie.com`; `vimeo.com/<id>[/<hash>]`, `/channels/…/<id>`, `/groups/…/videos/<id>`, `player.vimeo.com/video/<id>?h=`.
- **Rejected**: everything else, including other hosts, look-alike hosts, scripts, HTML, quotes and spaces.
- **Storage**: the canonical watch URL.
- **Embed**: built from the id only (`https://www.youtube-nocookie.com/embed/<id>?rel=0[&start=]`, `https://player.vimeo.com/video/<id>?dnt=1[&h=]`), in a sandboxed iframe (`allow-scripts allow-same-origin allow-presentation allow-popups`) with `referrerpolicy=strict-origin-when-cross-origin`, lazy loading, and only player permissions.
- **Block settings**: address (live validation and preview), accessible title, caption, aspect ratio (16:9, 4:3, 1:1, 21:9, 9:16), and the usual width, position and spacing.

### 13.6 Demonstration artifacts (tenant `demo-university`)

| Artifact | State | Where |
|---|---|---|
| Form **Student Resource Request**: Full Name (required), Email Address (required, email), Resource Category (required dropdown: Academic Support, Career Services, Campus Events, Technical Support), Description (multi-line, up to 2,000 characters) | **Published, staff-only audience, no recipient set** | Studio → Forms |
| Page **CMS Components Demo** (`/pages/cms-components-demo`): an info callout, a rich-text section, a YouTube video (*Big Buck Bunny*, Blender Foundation, CC BY 3.0) and the form | **Unpublished draft, staff only, not in navigation** | Studio → Sites & Pages → Manage Pages, or the Design rail while on `/pages/cms-components-demo` with Studio on. Draft preview: Manage Pages → Preview |

- **Trying them**:
  - Open the form, change or reorder fields, use *Preview & test* (validation only).
  - Open the demo page in Studio, select the Video block and paste another YouTube or Vimeo address.
  - In the draft preview, submitting the form shows "no notification recipient has been set".
- **Enabling email**:
  1. Set the SMTP variables and restart the backend.
  2. In Studio → Forms → Settings, enter a real recipient (for example the Student Success team's address) and publish the form.
- **Publishing to people**:
  1. Change the form's and the page's audiences to the people you want (for example Students).
  2. Publish the form, then publish (or schedule) the page.

### 13.7 Files

- **CMS (`feddrick-cms/`)**:
  - New `src/api/form/…/schema.json`, `src/api/publication-schedule/…/schema.json`, `src/api/edunexus/services/scheduler.js` and `config/cron-tasks.js`.
  - Changed `config/server.js` (cron), `src/api/edunexus/controllers/edunexus.js` (forms, schedules, scheduled state, delivery guard, blocking on edit) and `src/api/edunexus/routes/edunexus.js`.
  - Changed `announcement` (`bodyFormat`, body ≤ 50,000) and `faq` (`answerFormat`, answer ≤ 30,000).
  - The API token gained `scheduleGet` and `scheduleSet`.
- **Shared**: new `shared/forms.js`, `shared/video.js`, `shared/richHtml.js`; `shared/cmsBlocks.js` gains the `format`/`html` Text fields, the Video and Form blocks, and the `html`, `video` and `formRef` validator kinds.
- **Backend**:
  - New `src/modules/cms/richHtml.js`, `src/modules/cms/mailer.js`.
  - Changed `src/config/env.js` (`mailConfig`), `src/modules/cms/cmsService.js` (formats, sanitizing, forms, schedules, submissions, meta: timezone and mail status) and `src/modules/cms/cmsRoutes.js` (schedule, test-submission, form delivery and submission, rate limits).
  - Changed `.env.example`, `package.json` / lock (`sanitize-html`, `nodemailer`).
  - Tests: new `tests/cms-features.test.js` and `tests/helpers/smtpSink.js`; changed `tests/helpers/cmsStub.js` and `tests/helpers/testEnv.js` (SMTP variables blanked).
- **Frontend**:
  - New `components/cms/RichTextEditor.jsx`, `SafeHtml.jsx`, `CmsForm.jsx`, `markdownToHtml.jsx`; `pages/studio/ScheduleDialog.jsx`, `StudioForms.jsx`; `utils/zonedTime.js`.
  - Changed `components/cms/blocks/CmsBlocks.jsx`, `puckConfig.jsx`, `Markdown.jsx`; `pages/studio/StudioPageEditor.jsx`, `StudioPagesList.jsx`, `StudioContentList.jsx`, `StudioApp.jsx`, `studioCommon.jsx`; `layouts/StudioRail.jsx`; `services/api/cmsApi.js`; `package.json` / lock (TipTap packages declared at 3.32.0; nothing new downloaded); `tests/cms.test.mjs`.
- **Unchanged**: the EduNexusAI database (83 tables, 34 users, 12 migrations), SIS/LMS connectors, authentication, roles and dashboards.

### 13.8 Tests

| Check | Result |
|---|---|
| **Scheduler against the real CMS and cron** | Past time 400, unpublish ≤ publish 400, unpublish of an unpublished draft 409. Publish 40 s ahead: nothing delivered early, published on time. A cancelled schedule never ran. A page edited after scheduling was **blocked**, not published. At the unpublish time the item was hidden immediately, then unpublished by the job. Another tenant got 404. **Restart**: CMS stopped across a due time, restarted, and the job ran on the first cron run after the restart |
| **Through the backend (live)** | Student 403 on schedules; admin schedule → *Scheduled* in the list; not delivered before the time, delivered after it |
| **Forms (live, real CMS)** | Student 403 on Studio forms; invalid field names, empty dropdowns and bad recipients rejected; draft form not delivered; published staff-only form hidden from students (load and submit 404); recipient never exposed; required/email/unknown-field/out-of-list errors returned per field; no recipient → 503 `FORM_NOT_CONFIGURED`; SMTP unset → 503 `MAIL_NOT_CONFIGURED`; rate limit returned 429 after the burst limit |
| **Email delivery** | Through a local SMTP sink (real SMTP protocol, nothing leaves the machine): delivered to the configured recipient with subject, Reply-To and escaped HTML; a forced server error gave 502 `MAIL_FAILED`. **Not tested: delivery through a real provider** (no credentials available) |
| **Browser (Chrome)** | 26 / 26: Forms rail; demo form opens in order; reorder + label + required persist after save and reload, with the published version unchanged until published; settings show mail status; client and server validation in test mode; demo page in Studio shows the video (youtube-nocookie, sandboxed), form and rich text; invalid video URL message; a Vimeo URL updates canvas and settings preview; unsaved changes are not saved; draft preview renders video and a working form; a real submission reports the missing recipient honestly; student 404 on page and form; Visual → Source shows HTML; Source warnings for unsafe/malformed markup; confirmation before removal; Source → Visual formatted and cleaned; saved as sanitized HTML draft; reopened intact; draft not delivered; Schedule dialog shows the timezone and conflict warnings; schedule appears in Manage Pages and cancelling returns it to Draft. Also checked: the page Text block's Visual/Source editor in the properties panel |
| **Persistence** | After restarting both the CMS and the backend, the demo page (draft, staff), video URL, form reference and form fields were unchanged |
| **Regression** | In-place editing and scrolling 17 / 17; backend **230 / 230** (adds 15); frontend **47 / 47** (adds 4); lint clean (249 modules); production build OK. The page-renderer chunk stays about 622 KB because the editor loads on demand |

The test records created during verification (pages, news, a form, the `cms-verify` tenant's documents, schedule rows and audit entries) were removed. The demo artifacts above remain on purpose. A CMS database backup taken before the schema changes is kept outside the repository.

### 13.9 Outstanding

- Configure SMTP and a real recipient to send form email; then test one live submission end to end.
- Submissions are email-only by design. Storing them would need a decision on access and retention first.
- Scheduling runs every 20 s, so actions happen within about 20 s of the set time (delivery hides due unpublishes immediately).
- The scheduler runs inside the CMS process. Running several CMS instances is safe (claims are atomic) but untested.
