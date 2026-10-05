# Feedback worker

The uninstall page and the feedback page post a short note here. The worker checks it, then opens an issue in a private GitHub repository.

The issue is the only thing that is kept. The IP address is used as a rate-limit key and then dropped. It is not stored and not sent to GitHub. Request logs are off, so the note is not written to a log either.

## Setup

1. Create a private GitHub repository named `ashahinL/companion-feedback`. Leave it private. The issues are the messages.
2. Create a fine-grained personal access token that can access only that repository, with only Issues set to read and write.
3. In the Cloudflare dashboard, add a Turnstile widget for the hostname `ashahinl.github.io`. Choose managed mode. Keep the secret key for the next step. The site key is public.
4. From this folder, save the two secrets:

```
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TURNSTILE_SECRET
```

5. From this folder, deploy:

```
npx wrangler deploy
```

6. Paste the Turnstile site key into `TURNSTILE_SITE_KEY` in `site/feedback.js`.
