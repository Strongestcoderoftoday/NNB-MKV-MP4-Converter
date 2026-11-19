# NNB MKV → MP4 Converter

Standalone website and cloud FFmpeg runner for converting MKV files to the playback format used by Nihon no Benkyou (NNB).

## Included

- Static browser app (`index.html`, `app.js`, `styles.css`) for NNB login, Google Drive connection, chunked MKV upload, conversion progress and MP4 access.
- GitHub Actions runner and FFmpeg compatibility utilities under `cloudflare/transcoder/`.
- Regression tests for dispatch validation, remux/transcode classification, the NNB output profile and safe filenames.

## Flow

1. User signs in with their existing NNB Supabase account.
2. User connects their own Google Drive.
3. Browser calculates SHA-256 incrementally and uploads the source MKV in 32 MiB chunks through `POST /v1/converter/sources/init`. The NNB Worker stores it in the dedicated `converter_source` asset namespace in the user's Drive, separate from regular library assets.
4. NNB Media Worker creates an owner-scoped converter job and dispatches `nnb-mkv-convert` to this repository.
5. GitHub Actions installs FFmpeg on an Ubuntu runner. The runner asks the NNB Worker to prepare the job; the Worker verifies the signed token, owner, source asset and workflow instance before issuing the source URL.
6. FFprobe classifies the source. Compatible H.264/AAC is remuxed; other sources are transcoded.
7. The runner verifies the output codec profile and uploads the MP4 to the same user's Drive.

The repository contains no Google, Supabase secret key, B2 credential or internal HMAC secret. The dispatch token is short-lived and is validated by the NNB Worker on `/prepare` and subsequent internal calls. The runner masks it in Actions logs.

## NNB playback format

- MP4 container, `+faststart`
- Video: H.264 High, Level 4.1, `yuv420p`, up to 1920×1080 and 30 fps
- Audio: AAC-LC, 192 kbps, stereo, 48 kHz
- Subtitles remain external assets; they are not burned into the MP4


## Publish this repository

After extracting the ZIP on the Mac, run this in Terminal from the extracted folder (with `gh auth status` already showing `Strongestcoderoftoday`):

```bash
git init -b main
git add .
git commit -m "feat: add standalone NNB MKV to MP4 converter"
gh repo create Strongestcoderoftoday/NNB-MKV-MP4-Converter --public --source . --remote origin --push
```

The public visibility is deliberate: the repository contains application source only, no service secrets, and public standard GitHub-hosted runners are free.

## Deploy Cloudflare Pages

Create a Cloudflare Pages project named `nnb-mkv-converter` connected to this repository:

- Production branch: `main`
- Root directory: `/`
- Framework preset: `None`
- Build command: blank
- Build output directory: `/`

Expected site: `https://nnb-mkv-converter.pages.dev`.

The existing NNB Worker code includes a CORS allow rule for the `nnb-mkv-converter.pages.dev` hostname. Google OAuth returns to the converter site's own origin.

## Backend changes required in NNB

The matching Worker API and database migration are maintained in NNB PR #115:

https://github.com/Strongestcoderoftoday/Nihon-Benkyou-Personal-Japanese-Learning-Platform/pull/115

Before a real conversion can complete:

1. Merge/deploy the converter API in `nnb-media-api`, including the authenticated `POST /v1/converter/sources/init` endpoint and converter-only asset namespace.
2. Apply migration `20261119000000_nnb_standalone_converter_jobs.sql` to Supabase project `ffejfkoqnastynooilvs`.
3. Change the Worker dispatch target to `Strongestcoderoftoday/NNB-MKV-MP4-Converter`.
4. Ensure `GITHUB_ACTIONS_TOKEN` in the Worker can create `repository_dispatch` events on this repository.
5. Keep `TRANSCODE_INTERNAL_SECRET` only in the NNB Worker. It is not required as a GitHub Actions secret in this repo; the Worker validates the signed token.

The converter does not create a Movie/library item, edit subtitles, or modify viewing progress.

## Why public repository

Use a public repository if the goal is to keep standard GitHub-hosted runner usage free. GitHub documents standard runners in public repositories as free; private repositories draw usage from the account's included compute allowance and may be billed after that allowance is consumed. The source here contains no credentials or provider secrets.

## Run tests

```bash
node --test tests/converter-runner.test.js
node --check cloudflare/transcoder/src/github-actions-converter-runner.js
```
