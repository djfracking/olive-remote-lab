import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.djfracking.oliveremotelab",
  appName: "Olive Remote",
  webDir: "dist",
  android: {
    allowMixedContent: true,
  },
  plugins: {
    SystemBars: {
      insetsHandling: "css",
      style: "DARK",
      hidden: false,
    },
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
