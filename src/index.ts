//import jsonata from "jsonata"
import { httpRequest } from "@gallofeliz/http-request";
import { runApp } from "@gallofeliz/application";
import { UniversalLogger } from "@gallofeliz/logger";
import { runServer } from "@gallofeliz/http-server";
import { OutputHandler, InfluxDBOutputHandler } from './output'
import { Scheduler } from "@gallofeliz/scheduler";
import {
    networkStats/*, networkConnections */,
    mem,
    dockerInfo,
    dockerContainers,
    dockerContainerStats
} from "systeminformation";
import os from 'os'
import { DockerLogs } from '@gallofeliz/docker-logs'
// @ts-ignore
import SolarCalc from "solar-calc/lib/solarCalc";
import { runProcess } from "@gallofeliz/run-process";
import { glob } from 'glob'
import { readFile } from 'fs/promises'
import {tsToJsSchema} from '@gallofeliz/typescript-transform-to-json-schema'

interface MetricCollect {
    name: string
    handle: (opts: {
        logger: UniversalLogger,
        outputHandler: OutputHandler,
        abortSignal: AbortSignal,
        scheduler: Scheduler,
        hostname: string
        dockerLogsService: DockerLogs
    }) => void
}

interface UserConfig {
    ialive: {
        user: string
        pass: string
    }
    hc: {
        id: string
    }
}

runApp<UserConfig>({
    config: {
        envPrefix: 'MC',
        userProvidedConfigSchema: tsToJsSchema<UserConfig>()
    },
    services: {
        collects({config}) {

            const collects: MetricCollect[] = [
                {
                    name: 'iAlive',
                    handle({logger, outputHandler, abortSignal}) {
                        runServer({
                            abortSignal,
                            port: 1313,
                            logger,
                            auth: {
                                users: [{
                                    username: config.ialive.user,
                                    password: config.ialive.pass,
                                    autorisations: ['ping']
                                }]
                            },
                            routes: [{
                                path: '/ping',
                                requiredAuthorization: 'ping',
                                async handler() {
                                    await outputHandler.handle({
                                        name: 'ialive',
                                        date: new Date,
                                        values: {
                                            pingv2: 1
                                        }
                                    })
                                }
                            }]
                        })
                    }
                },
                {
                    name: 'grafanaToHcPing',
                    handle({scheduler, abortSignal, logger}) {
                        scheduler.addSchedule({
                            id: 'grafanaToHcPing',
                            schedule: '*/15 * * * *',
                            async fn() {

                                const hcId = config.hc.id

                                try {
                                    await httpRequest({
                                        abortSignal,
                                        logger,
                                        url: 'http://grafana/api/health',
                                        responseType: 'json',
                                    })

                                } catch (e) {
                                    await httpRequest({
                                        abortSignal,
                                        logger,
                                        url: `https://hc-ping.com/${hcId}/fail`,
                                    })
                                    return
                                }

                                await httpRequest({
                                    abortSignal,
                                    logger,
                                    url: `https://hc-ping.com/${hcId}`,
                                })
                            },
                        })
                    }
                },
                {
                    name: 'host.cpuload',
                    handle({scheduler, outputHandler, hostname}) {
                        scheduler.addSchedule({
                            id: 'host.cpuload',
                            schedule: '* * * * *',
                            async fn({triggerDate}) {

                                const [load1, load5, load15] = os.loadavg()

                                outputHandler.handle({
                                    name: 'host.cpuload',
                                    date: triggerDate,
                                    tags: {
                                        hostname
                                    },
                                    values: {
                                        load1,
                                        load5,
                                        load15
                                    }
                                })
                            },
                        })
                    }
                },
                {
                    name: 'host.memory',
                    handle({scheduler, outputHandler, hostname}) {
                        scheduler.addSchedule({
                            id: 'host.memory',
                            schedule: '* * * * *',
                            async fn({triggerDate}) {

                                const data = await mem()

                                outputHandler.handle({
                                    name: 'host.memory',
                                    date: triggerDate,
                                    tags: {
                                        hostname
                                    },
                                    values: {
                                        free: data.free,
                                        available: data.available,
                                        used: data.used,
                                        active: data.active,
                                        usedPct: data.used / data.total * 100,
                                        activePct: data.active / data.total * 100,
                                        swap: {
                                            used: data.swapused,
                                            free: data.swapfree,
                                            usedPct: data.swapused / data.swaptotal * 100
                                        }
                                    }
                                })
                            },
                        })
                    }
                },

                {
                    name: 'host.docker.stats',
                    handle({scheduler, outputHandler, hostname}) {
                        scheduler.addSchedule({
                            id: 'host.dockerstats',
                            schedule: '*/5 * * * *',
                            async fn({triggerDate}) {

                                const e = await dockerInfo()

                                outputHandler.handle({
                                    name: 'host.dockerstats',
                                    date: triggerDate,
                                    tags: {
                                        hostname
                                    },
                                    values: {
                                        nbContainers: e.containers,
                                        nbContainersByState: {
                                            running: e.containersRunning,
                                            paused: e.containersPaused,
                                            stopped: e.containersStopped
                                        },
                                        nbImages: e.images,
                                    }
                                })
                            },
                        })
                    }
                },
                {
                    name: 'host.docker.containers.stats',
                    handle({scheduler, outputHandler, hostname}) {
                        scheduler.addSchedule({
                            id: 'host.docker.containers.stats',
                            schedule: '*/5 * * * *',
                            async fn({triggerDate}) {

                                const f = await dockerContainers(false)
                                const activeIds = f.map(c => c.id)
                                const g = await dockerContainerStats(activeIds.join(','))


                                const h = f.reduce((h, c) => ({...h, [c.id]: c}), {})
                                const i = g.reduce((h, c) => ({...h, [c.id]: c}), {})

                                outputHandler.handle(Object.keys(h).map(containerId => {

                                    // @ts-ignore
                                    const a = h[containerId]
                                    // @ts-ignore
                                    const b = i[containerId]

                                    return {
                                        name: 'host.docker.containers.stats',
                                        date: triggerDate,
                                        tags: {
                                            hostname,
                                            container: {
                                                id: a.id,
                                                name: a.name
                                            }
                                        },
                                        values: {
                                            uptime: triggerDate.getTime() - (a.started * 1000),
                                            memUsage: b.memUsage,
                                            memPct: b.memPercent,
                                            cpuPct: b.cpuPercent
                                        }
                                    }

                                }))
                            },
                        })
                    }
                },
                {
                    name: 'chickencoop',
                    handle({scheduler, abortSignal, logger, outputHandler}) {
                        scheduler.addSchedule({
                            id: 'chickencoop',
                            schedule: '*/5 * * * *',
                            async fn({triggerDate}) {
                                const coop: any = await httpRequest({
                                    abortSignal,
                                    logger,
                                    url: 'http://chickencooppi',
                                    responseType: 'json',
                                })

                                const strStatusToInt: any = {
                                    "CLOSED (LOCKED)": -2,
                                    "CLOSED (UNLOCKED)": -1,
                                    "CLOSED": 0,
                                    "OPEN": 1,
                                    "OPEN (PARTIAL)": 2,
                                    "OPEN (TOTAL)": 3
                                }

                                outputHandler.handle({
                                    name: 'chickencoop',
                                    date: triggerDate,
                                    values: {
                                        temperature: coop.temperature,
                                        humidity: coop.humidity,
                                        humanDoorStatus: strStatusToInt[coop.humanDoorStatus as string],
                                        chickenDoorStatus: strStatusToInt[coop.chickenDoorStatus as string]
                                    }
                                })

                            },
                        })
                    }
                },
                {
                    name: 'solar',
                    handle({scheduler, outputHandler, hostname}) {
                        scheduler.addSchedule({
                            id: 'solar',
                            schedule: '*/5 * * * *',
                            async fn({triggerDate}) {
                                const solar = new SolarCalc(triggerDate, 49.0940359, 1.4867724)

                                outputHandler.handle({
                                    name: 'solar',
                                    date: triggerDate,
                                    tags: {
                                        hostname
                                    },
                                    values: {
                                        sunLight: (triggerDate > solar.sunrise && triggerDate < solar.sunset) ? 1 : 0,
                                        civilLight: (triggerDate > solar.civilDawn && triggerDate < solar.civilDusk) ? 1 : 0,
                                        nauticalLight: (triggerDate > solar.nauticalDawn && triggerDate < solar.nauticalDusk) ? 1 : 0,
                                        astronomicalLight: (triggerDate > solar.astronomicalDawn && triggerDate < solar.astronomicalDusk) ? 1 : 0,
                                    }
                                })
                            },
                        })
                    }
                },
                {
                    name: 'host.netstats',
                    handle({scheduler, outputHandler, hostname}) {
                        scheduler.addSchedule({
                            id: 'host.netstats',
                            schedule: '* * * * *',
                            async fn({triggerDate}) {

                                const netstats = await networkStats()

                                outputHandler.handle(netstats.filter(ifaceStats => ifaceStats.ms !== 0).map(ifaceStats => ({
                                    name: 'host.netstats',
                                    date: triggerDate,
                                    tags: {
                                        hostname,
                                        iface: ifaceStats.iface
                                    },
                                    values: {
                                        rxSec: ifaceStats.rx_sec,
                                        txSec: ifaceStats.tx_sec
                                    }

                                })))
                            },
                        })
                    }
                },
                {
                    name: 'backups',
                    handle({dockerLogsService, abortSignal, logger, outputHandler}) {
                        dockerLogsService.watch({
                            namePattern: '*backuper*',
                            abortSignal,
                            onLog(log) {
                                let objLog

                                try {
                                    objLog = JSON.parse(log.message)
                                } catch (e) {
                                    logger.error('Unable to parse log for backups')
                                    return
                                }

                                if (objLog.levelname === 'DEBUG') {
                                    return
                                }

                                outputHandler.handle({
                                    name: 'backups',
                                    date: log.date,
                                    tags: {
                                        levelname: objLog.levelname,
                                        action: objLog.action,
                                        backup: objLog.backup,
                                        repository: objLog.repository,
                                        status: objLog.status
                                    },
                                    values: {
                                        nb: 1
                                    }
                                })

                            }
                        })
                    }
                },

                {
                    name: 'doctolib',
                    handle({dockerLogsService, abortSignal, logger, outputHandler}) {
                        dockerLogsService.watch({
                            namePattern: '*doctolib*',
                            abortSignal,
                            onLog(log) {
                                let objLog

                                try {
                                    objLog = JSON.parse(log.message)
                                } catch (e) {
                                    logger.error('Unable to parse log for doctolib')
                                    return
                                }

                                if (objLog.level === 'debug') {
                                    return
                                }

                                if (objLog.level === 'info' && !['done', 'failed'].includes(objLog.status)) {
                                    return
                                }

                                const status = objLog.status || 'error'

                                outputHandler.handle({
                                    name: 'doctolib',
                                    date: log.date,
                                    tags: {
                                        status,
                                    },
                                    values: {
                                        nb: 1
                                    }
                                })
                            }
                        })
                    }
                },

                {
                    name: 'metricsCollectErrors',
                    handle({abortSignal, outputHandler, logger, scheduler, hostname, dockerLogsService}) {

                        let nbErrors = 0

                        dockerLogsService.watch({
                            namePattern: 'metrics-collector-app-*',
                            abortSignal,
                            onLog(log) {
                                let objLog

                                try {
                                    objLog = JSON.parse(log.message)
                                } catch (e) {
                                    logger.error('Unable to parse log for metricsCollectErrors')
                                    return
                                }

                                if (objLog.level === 'error') {
                                    nbErrors++
                                }
                            }
                        })

                        scheduler.addSchedule({
                            id: 'metrics.logs.push',
                            schedule: '* * * * *',
                            fn({triggerDate}) {
                                outputHandler.handle({
                                    name: 'metricsCollectErrors',
                                    date: triggerDate,
                                    tags: {
                                        hostname
                                    },
                                    values: {
                                        count: nbErrors
                                    }
                                })
                                nbErrors = 0
                            }
                        })
                    }
                },
                {
                    name: 'host.diskstats',
                    async handle({scheduler, outputHandler, hostname, abortSignal, logger}) {

                        scheduler.addSchedule({
                            id: 'host.diskstats',
                            schedule: '*/30 * * * *',
                            async fn({triggerDate}) {

                                const df: string = await runProcess({
                                    abortSignal,
                                    command: ['df', '/'],
                                    outputType: 'text',
                                    logger
                                })

                                const [, , strUsedK, strAvailableK] = df.split('\n').reverse()[0].split(/ +/)

                                const used = parseInt(strUsedK) * 1024
                                const available = parseInt(strAvailableK) * 1024
                                const total = used + available

                                outputHandler.handle({
                                    name: 'host.diskstats',
                                    date: triggerDate,
                                    tags: {
                                        hostname
                                    },
                                    values: {
                                        used,
                                        available,
                                        total,
                                        usedPct: used / total * 100,
                                        availablePct: available / total * 100
                                    }

                                })
                            },
                        })
                    }
                },
                {
                    name: 'host.processes',
                    // from https://github.com/influxdata/telegraf/blob/master/plugins/inputs/processes/processes_notwindows.go#L132
                    async handle({scheduler, outputHandler, hostname, abortSignal, logger}) {

                        const stateMapping = {
                            R: 'running',
                            S: 'sleeping',
                            D: 'blocked',
                            Z: 'zombies',
                            X: 'dead',
                            T: 'stopped',
                            t: 'stopped',
                            W: 'paging',
                            I: 'idle',
                            P: 'parked'
                        }

                        scheduler.addSchedule({
                            id: 'host.processes',
                            schedule: '*/5 * * * *',
                            async fn({triggerDate}) {

                                try {
                                    // from https://github.com/influxdata/telegraf/blob/master/plugins/inputs/processes/processes_notwindows.go
                                    const dirs = await glob('+([0-9])', { cwd: '/hostproc', absolute: true})

                                    const processesData = await Promise.all(
                                        dirs
                                        .map(dir => dir + '/stat')
                                        .map(file => readFile(file, { encoding: 'utf8' }).catch(e => {
                                            if (e.code === 'ENOENT' || e.code === 'ESRCH') {
                                                return
                                            }

                                            logger.error('Error reading file host.processes', {e})
                                        }))
                                    )

                                    const stats = processesData.reduce((stats, processData) => {
                                        if (!processData) {
                                            return stats
                                        }

                                        stats.nbProcesses++

                                        const data = processData.trimRight().split(/ +/)

                                        const nbThreads = data[19]

                                        stats.nbThreads += parseInt(nbThreads)

                                        const state: string = data[2];

                                        // @ts-ignore
                                        stats.nbProcessesByState[stateMapping[state]]++

                                        return stats
                                    }, {
                                        nbProcesses: 0,
                                        nbThreads: 0,
                                        nbProcessesByState: Object.values(stateMapping).reduce((init, k) => ({...init, [k]: 0}), {})
                                    })

                                    if (stats.nbProcesses === 0) {
                                        throw new Error('Something wrong')
                                    }

                                    outputHandler.handle({
                                        name: 'host.processes',
                                        date: triggerDate,
                                        tags: {
                                            hostname
                                        },
                                        values: stats
                                    })

                                } catch (e) {
                                    console.error(e)
                                }
                            },
                        })
                    }
                },

            ]

            return collects
        }
    },
    async run({abortSignal, logger, config, collects}) {

        const outputHandler = new InfluxDBOutputHandler({dbName: 'main'})
        const scheduler = new Scheduler({logger})
        const hostname = os.hostname()
        const dockerLogsService = new DockerLogs
        process.setMaxListeners(collects.length * 2)

        collects.forEach((collect: any) => {
            logger.info('Registering collect ' + collect.name)
            collect.handle({
                abortSignal,
                logger,
                outputHandler,
                scheduler,
                hostname,
                dockerLogsService
            })
        })

        scheduler.start(abortSignal)
    }
})
