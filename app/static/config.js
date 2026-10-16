/* Data Cloud Compass - deployment settings (edit and redeploy, or set the matching Cloud Run env vars).
 *  feedbackUrl     : link to your feedback form (e.g. a Google Form). Shows a "Feedback" button when set.  Env: FEEDBACK_URL
 *  googleClientId  : OAuth web client ID for "Create in my Google Drive" exports.                        Env: GOOGLE_OAUTH_CLIENT_ID
 */
window.COMPASS_CONFIG = Object.assign({ feedbackUrl: "", googleClientId: "" }, window.COMPASS_CONFIG || {});
