export interface Env {
  APP_ORIGIN: string;
  ASSETS_ORIGIN: string;
  DEV: boolean;
  ESM_ORIGIN: string;
  FILES_ORIGIN: string;
  MODE: "development" | "production" | "staging" | "test";
  ORIGIN: string;
}
