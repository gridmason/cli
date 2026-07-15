---
"@gridmason/cli": patch
---

publish: poll review status at `GET /v1/artifacts/:id/status` (registry path collision fix, #67)

The registry's bare `GET /v1/artifacts/:id` template is its frozen, hash-addressed
artifact-serving origin, so publisher review status moved to
`GET /v1/artifacts/:id/status`. `getReviewStatus` now polls the `/status` path;
response shapes and the `POST /v1/artifacts/:id/appeal` path are unchanged.
