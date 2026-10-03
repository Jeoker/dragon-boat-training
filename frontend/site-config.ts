const appPath = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

export const siteConfig = {
  appPath,
  historyPath: `${appPath}history/`,
  coachPath: `${appPath}coach/`,
  apiUrl: import.meta.env.PUBLIC_DRAGON_BOAT_API_URL
    || "https://script.google.com/macros/s/AKfycbw4c8mBbop9Qnq29nYQ_AtLembq1OHKt_nRjIv3EE9kw0DliTVM0lMY6svr8X0gcQW8/exec"
};
