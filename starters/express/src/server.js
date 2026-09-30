import { loadConfig, ConfigError } from "./config.js";
import { createApp } from "./app.js";

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
}

createApp(config).listen(config.port, config.host, () => {
  console.log(`Listening on ${config.baseUrl}`);
  console.log(`  issuer    ${config.issuer}`);
  console.log(`  client id ${config.clientId}`);
});
