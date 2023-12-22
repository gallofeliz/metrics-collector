//import jsonata from "jsonata"
import { httpRequest } from "@gallofeliz/http-request";
import { runApp } from "@gallofeliz/application";
import { UniversalLogger } from "@gallofeliz/logger";
import { runServer } from "@gallofeliz/http-server";
import { OutputHandler, InfluxDBOutputHandler } from './output'
import { Scheduler } from "@gallofeliz/scheduler";
import {
    networkStats/*, networkConnections */,
    mem
} from "systeminformation";
import os from 'os'
import { DockerLogs } from '@gallofeliz/docker-logs'
// @ts-ignore
import SolarCalc from "solar-calc/lib/solarCalc";
import { runProcess } from "@gallofeliz/run-process";
import { glob } from 'glob'
import { readFile } from 'fs/promises'
import {tsToJsSchema} from '@gallofeliz/typescript-transform-to-json-schema'
import Dockerode from 'dockerode'

interface MetricCollect {
    name: string
    handle: (opts: {
        logger: UniversalLogger,
        outputHandler: OutputHandler,
        abortSignal: AbortSignal,
        scheduler: Scheduler,
        hostname: string
        dockerLogsService: DockerLogs
        dockerode: Dockerode
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
                    name: 'boiler-around-temp',
                    handle({scheduler, abortSignal, logger, outputHandler}) {
                        scheduler.addSchedule({
                            id: 'boiler-around-temp',
                            schedule: '*/15 * * * *',
                            async fn({triggerDate}) {



                                try {
                                    const {temperature} = await httpRequest<{temperature: number}>({
                                        abortSignal,
                                        logger,
                                        url: 'http://192.168.1.2:1234/f0:c7:7f:85:bd:30',
                                        responseType: 'json',
                                    })

                                    outputHandler.handle({
                                        name: 'boiler_around_temp',
                                        date: triggerDate,
                                        values: {
                                            temperature,
                                        }
                                    })


                                } catch (e) {
                                    logger.error('Error', {e})
                                    return
                                }

                            },
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
                    handle({scheduler, outputHandler, hostname, dockerode}) {
                        scheduler.addSchedule({
                            id: 'host.dockerstats',
                            schedule: '*/5 * * * *',
                            async fn({triggerDate}) {

                                const infos = await dockerode.info()

                                outputHandler.handle({
                                    name: 'host.dockerstats',
                                    date: triggerDate,
                                    tags: {
                                        hostname
                                    },
                                    values: {
                                        nbContainers: infos.Containers,
                                        nbContainersByState: {
                                            running: infos.ContainersRunning,
                                            paused: infos.ContainersPaused,
                                            stopped: infos.ContainersStopped
                                        },
                                        nbImages: infos.Images,
                                        nbWarnings: infos.Warnings?.length || 0
                                    }
                                })
                            },
                        })
                    }
                },
                {
                    name: 'host.docker.containers.stats',
                    handle({scheduler, outputHandler, hostname, dockerode}) {
                        scheduler.addSchedule({
                            id: 'host.docker.containers.stats',
                            schedule: '*/5 * * * *',
                            async fn({triggerDate}) {

                                const containers = await dockerode.listContainers({all: true})

                                function mapState(state: string) {
                                    switch(state.toLowerCase()) {
                                        case 'created':
                                            return 0
                                        case 'running':
                                            return 1
                                        case 'pause':
                                            return 2
                                        case 'restarting':
                                            return 3
                                        case 'removing':
                                            return -1
                                        case 'exited':
                                            return -2
                                        case 'dead':
                                            return -3
                                        default:
                                            return -10
                                    }
                                }

                                function mapHealth(status: string) {
                                    switch(status.toLowerCase()) {
                                        case 'none':
                                            return 0
                                        case 'starting':
                                            return 1
                                        case 'healthy':
                                            return 2
                                        case 'unhealthy':
                                            return -1
                                        default:
                                            return -10
                                    }
                                }

                                const stats = await Promise.all(containers.map(async container => {

                                    const inspect = await dockerode.getContainer(container.Id).inspect()
                                    const stats = await dockerode.getContainer(container.Id).stats({stream: false})

                                    return {
                                        name: 'host.docker.containers.stats',
                                        date: triggerDate,
                                        tags: {
                                            hostname,
                                            container: {
                                                id: container.Id,
                                                name: container.Names[0].substring(1),
                                                 ...container.Labels['com.docker.compose.project']
                                                    && {
                                                        compose: {
                                                            project: container.Labels['com.docker.compose.project'],
                                                            service: container.Labels['com.docker.compose.service']
                                                        }
                                                    }

                                            }
                                        },
                                        values: {
                                            createdSince: triggerDate.getTime() - (container.Created * 1000),
                                            ...inspect.State.Running && {uptime: triggerDate.getTime() - (new Date(inspect.State.StartedAt)).getTime()},
                                            ...inspect.State.StartedAt && {lastStartedSince: triggerDate.getTime() - (new Date(inspect.State.StartedAt)).getTime()},
                                            ...inspect.State.FinishedAt && {lastFinishedSince: triggerDate.getTime() - (new Date(inspect.State.FinishedAt)).getTime()},
                                            ...inspect.State.ExitCode && {lastExitCode: inspect.State.ExitCode},
                                            state: mapState(container.State),
                                            restartCount: inspect.RestartCount,
                                            health: mapHealth(inspect.State.Health?.Status || 'none'),
                                            //nbPids: stats.pids_stats?.current,
                                            memUsage: stats.memory_stats.usage ? stats.memory_stats.usage - (stats.memory_stats.stats.cache || 0) : 0,
                                            memPct: stats.memory_stats.usage ? (stats.memory_stats.usage - (stats.memory_stats.stats.cache || 0)) / stats.memory_stats.limit * 100 : 0,
                                            cpuPct: stats.cpu_stats.cpu_usage.total_usage ? ((stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage)
                                                / (stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage)) * stats.cpu_stats.online_cpus * 100 : 0,
                                        }


                                    }
                                }))

                                outputHandler.handle(stats)
                            },
                        })
                    }
                },
                // {
                //     name: 'solar',
                //     handle({scheduler, outputHandler, hostname}) {
                //         scheduler.addSchedule({
                //             id: 'solar',
                //             schedule: '*/5 * * * *',
                //             async fn({triggerDate}) {
                //                 const solar = new SolarCalc(triggerDate, 49.0940359, 1.4867724)

                //                 outputHandler.handle({
                //                     name: 'solar',
                //                     date: triggerDate,
                //                     tags: {
                //                         hostname
                //                     },
                //                     values: {
                //                         sunLight: (triggerDate > solar.sunrise && triggerDate < solar.sunset) ? 1 : 0,
                //                         civilLight: (triggerDate > solar.civilDawn && triggerDate < solar.civilDusk) ? 1 : 0,
                //                         nauticalLight: (triggerDate > solar.nauticalDawn && triggerDate < solar.nauticalDusk) ? 1 : 0,
                //                         astronomicalLight: (triggerDate > solar.astronomicalDawn && triggerDate < solar.astronomicalDusk) ? 1 : 0,
                //                     }
                //                 })
                //             },
                //         })
                //     }
                // },
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
                    name: 'host.docker.containers.logs',
                    handle({scheduler, dockerLogsService, abortSignal, logger, outputHandler, hostname}) {
                        let aggregate: { [k: string]: { [k: string]: number } } = {}

                        function increment(containerName: string, level: string) {
                            if (!aggregate[containerName]) {
                                aggregate[containerName] = {}
                            }

                            if (aggregate[containerName][level] === undefined) {
                                aggregate[containerName][level] = 0
                            }

                            aggregate[containerName][level]++
                        }

                        dockerLogsService.watch({
                            namePattern: '*',
                            abortSignal,
                            onLog(log) {
                                const isJson = log.container.name.match(/youtube|collector|backuper|doctolib|traefik/i)
                                const isLvl = log.container.name.match(/grafana|influx/i)

                                if (isJson) {
                                    try {
                                        const lg = JSON.parse(log.message)
                                        increment(log.container.name, lg.level)
                                    } catch (e) {
                                        increment(log.container.name, 'unknown')
                                    }
                                } else if (isLvl) {
                                    const search = log.message.match(' lvl=([^ ]+) ')

                                    if (search && search[1]) {
                                        increment(log.container.name, search[1])
                                    } else {
                                        increment(log.container.name, 'unknown')
                                    }

                                } else {
                                    increment(log.container.name, 'unknown')
                                }

                            }
                        })

                        scheduler.addSchedule({
                            id: 'host.docker.containers.logs',
                            schedule: '* * * * *',
                            fn({triggerDate}) {

                                const stats = Object.keys(aggregate).reduce((stats, containerName) => {

                                    const containerStats = Object.keys(aggregate[containerName]).map(level => {
                                            return {
                                                name: 'metricsCollectLogs',
                                                date: triggerDate,
                                                tags: {
                                                    hostname,
                                                    container: {
                                                        name: containerName
                                                    },
                                                    level
                                                },
                                                values: {
                                                    nb: aggregate[containerName][level]
                                                }
                                            }
                                        })


                                    return stats.concat(containerStats as any)

                                }, [])

                                outputHandler.handle(stats)
                                aggregate = {}
                            }
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
                                    logger.error('Unable to parse log for doctolib', {logMessage: log.message})
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
        const dockerode = new Dockerode()

        collects.forEach((collect: any) => {
            logger.info('Registering collect ' + collect.name)
            collect.handle({
                abortSignal,
                logger,
                outputHandler,
                scheduler,
                hostname,
                dockerLogsService,
                dockerode
            })
        })

        scheduler.start(abortSignal)
    }
})
