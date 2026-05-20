// ACKNOWLEGEMENT:
// This project is slightly adapted from the work of Rémi, an amazing
// developer who also loves retro computing.
// The inspiration source: https://github.com/remino/timeprox
// Rémi's website: https://remino.net

import { ensureCacheDir, loadConfig } from "./lib/config";
import { Dependencies } from "./lib/dependencies";
import { TimeMachineService } from "./services/time-machine";

const config = loadConfig();
ensureCacheDir(config.cacheDir);

const dependencies = new Dependencies(config);
const { logger, shutdown, proxy, cache, validator } = dependencies.get();
const service = new TimeMachineService(config, proxy, cache, validator, shutdown, logger, () =>
	dependencies.close(),
);

service.start();
