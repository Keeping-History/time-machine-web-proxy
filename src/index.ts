// ACKNOWLEGEMENT:
// This project is slightly adapted from the work of Rémi, an amazing
// developer who also loves retro computing.
// The inspiration source: https://github.com/remino/timeprox
// Rémi's website: https://remino.net

import { ensureCacheDir, loadConfig } from "./lib/config";
import { Dependencies } from "./lib/dependencies";
import { createLogger } from "./lib/logger";
import { installOutboundProxy } from "./lib/outbound-proxy";
import { TimeMachineService } from "./services/time-machine";

const config = loadConfig();
ensureCacheDir(config.cacheDir);

// Install the outbound HTTP proxy dispatcher BEFORE constructing Dependencies
// so BullMQ's Lua-loader probes (at Queue construction) and every downstream
// fetch() — including the wayback-machine-downloader's internal CDX queries —
// route through the configured proxy. setGlobalDispatcher is a process-wide
// mutation; this is the single call site.
const bootLogger = createLogger();
installOutboundProxy(config, bootLogger);

const dependencies = new Dependencies(config);
const { logger, shutdown, proxy, cache, validator } = dependencies.get();
const service = new TimeMachineService(config, proxy, cache, validator, shutdown, logger, () =>
	dependencies.close(),
);

service.start();
