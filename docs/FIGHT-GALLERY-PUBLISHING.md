# Publish the reviewed fight gallery

The gallery is a static site: no backend, telemetry or third-party image host.
Opening a committed HTML file on GitHub shows its source. Download the reviewed
directory and open `index.html` locally to view it before publishing.

## Public launch

Only after the repository owner approves publication and the release checks pass:

1. Change the **release** repository's visibility to public. Keep both historical
   archive repositories private. Visibility changes are not performed by this workflow.
2. In repository **Settings → Pages**, choose **GitHub Actions** as the source.
3. Open **Actions → Publish reviewed fight gallery → Run workflow**, choose
   `main`, and explicitly enable `publish_reviewed_gallery`.
4. Inspect the deployment URL reported by the workflow and test a replay, image
   download and JSON download. Then use that verified URL for the README's gallery
   and replay links. Do not advertise a planned URL as an already-live site.

The workflow is manual, defaults to no publication, refuses private repositories
and non-main refs, and stages only named public assets from all six reviewed
cards. Incomplete galleries and mismatched evidence/asset hashes stop staging.
It does not upload the repository root, other documentation, raw benchmark
directories or arbitrary files placed beside the reviewed packages.

The expected project-site address is `https://bantam-admin.github.io/bantam-factory/`,
but the successful deployment output—not this prediction—is authoritative.
Normal commits never redeploy automatically; each update needs explicit dispatch.

This follows GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
Pages settings and a public deployment have deliberately not been activated
during private release preparation. A local staging pass does not prove the
external deployment has succeeded.
