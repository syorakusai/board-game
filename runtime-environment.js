// Cloudflare builds provide an explicit environment; GitHub Pages keeps its path fallback.
export const deploymentEnvironment = globalThis.HISOMEGOTO_DEPLOY_ENV;
export const isDevelopment = () => deploymentEnvironment !== undefined
  ? deploymentEnvironment !== "prod"
  : /\/board-game\/dev(?:\/|$)/.test(location.pathname);
export const isDeploymentEnabled = () => deploymentEnvironment !== undefined
  || /\/board-game(?:\/dev)?(?:\/|$)/.test(location.pathname);
