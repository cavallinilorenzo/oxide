# Startup spinner

Reference: [the supplied Google spinner GIF](https://miro.medium.com/1*X8HyF0-2dqv6DKYb-hzfpw.gif).

The reference contains 163 frames over 6.51 seconds. The blue arc completes six clockwise turns while repeatedly expanding and contracting. Its endpoints are flat, with no stationary track underneath.

`web/src/startup.css` records the measured arc angles instead of approximating the reference with independent rotation and dash animations. The SVG's `pathLength="360"` expresses arc lengths and offsets in degrees. Redundant samples within half a degree were removed; the raster reference's 3.5-degree endpoint discrepancy is distributed across the cycle so the native SVG loops continuously.

The existing Oxide mark and loading copy remain. Both the initial HTML splash and the React loading screen share the same stylesheet. The splash still disappears as soon as Project/Thread loading completes, without a minimum animation duration. Hidden windows pause the loop; reduced motion keeps a static arc.

`web/scripts/startup-review.mjs` exercises the real HTML bootstrap with synthetic IPC. It captures the previous implementation from commit `db4381a`, scrubs the new animation at fixed timestamps, checks the loop seam, tests reduced motion and visibility changes, and releases startup to verify immediate dismissal.

Run against the Vite development server:

```powershell
$env:OXIDE_REVIEW_URL = 'http://127.0.0.1:1421'
node scripts/startup-review.mjs ../docs/ui-review/startup
```

Run from `web/` with Playwright installed or provide its module through `OXIDE_PLAYWRIGHT_MODULE`. The images and `verification.json` record the checked poses and browser results.
