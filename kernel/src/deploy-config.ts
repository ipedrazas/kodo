// Deploy-time configuration. The kernel image and scripts/deploy.sh replace
// this file with values from the environment before `celld deploy`; with the
// defaults here every request is refused, because no identity can be checked.
export const DEPLOY_CONFIG = {
  issuer: "",
  audience: "",
  jwksUrl: "",
  adminTokenSha256: "",
  gatekeeperUrl: "",
  gatekeeperKey: "",
  fleet: "",
};
