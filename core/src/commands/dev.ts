/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import chalk from "chalk"
import { readFile } from "fs-extra"
import { flatten } from "lodash"
import { join } from "path"

import { getModuleWatchTasks } from "../tasks/helpers"
import { Command, CommandParams, CommandResult, handleProcessResults, PrepareParams } from "./base"
import { STATIC_DIR } from "../constants"
import { processModules } from "../process"
import { GardenModule } from "../types/module"
import { getTestTasks } from "../tasks/test"
import { ConfigGraph } from "../config-graph"
import {
  getModulesByServiceNames,
  getHotReloadServiceNames,
  getMatchingServiceNames,
  validateHotReloadServiceNames,
  makeSkipWatchErrorMsg,
} from "./helpers"
import { startServer } from "../server/server"
import { BuildTask } from "../tasks/build"
import { DeployTask } from "../tasks/deploy"
import { Garden } from "../garden"
import { LogEntry } from "../logger/log-entry"
import { BooleanParameter, StringsParameter } from "../cli/params"
import { printHeader } from "../logger/util"
import { GardenService } from "../types/service"
import deline = require("deline")
import dedent = require("dedent")
import moment = require("moment")
import { ParameterError } from "../exceptions"

const ansiBannerPath = join(STATIC_DIR, "garden-banner-2.txt")

const devArgs = {
  services: new StringsParameter({
    help: `Specify which services to develop (defaults to all configured services).`,
  }),
}

const devOpts = {
  "force": new BooleanParameter({ help: "Force redeploy of service(s)." }),
  "hot-reload": new StringsParameter({
    help: deline`The name(s) of the service(s) to deploy with hot reloading enabled.
      Use comma as a separator to specify multiple services. Use * to deploy all
      services with hot reloading enabled (ignores services belonging to modules that
      don't support or haven't configured hot reloading).
    `,
    alias: "hot",
  }),
  "local-mode": new StringsParameter({
    help: deline`[EXPERIMENTAL] The name(s) of the service(s) to be started locally with local mode enabled.
    Use comma as a separator to specify multiple services. Use * to deploy all
    services with local mode enabled. When this option is used,
    the command is run in persistent mode.

    This always takes the precedence over the dev mode if there are any conflicts,
    i.e. if the same services are passed to both \`--dev\` and \`--local\` options.
    `,
    alias: "local",
  }),
  "skip-tests": new BooleanParameter({
    help: "Disable running the tests.",
  }),
  "test-names": new StringsParameter({
    help:
      "Filter the tests to run by test name across all modules (leave unset to run all tests). " +
      "Accepts glob patterns (e.g. integ* would run both 'integ' and 'integration').",
    alias: "tn",
  }),
  "skip-watch": new BooleanParameter({
    help: deline`[EXPERIMENTAL] Watching is enabled by default but can be disabled
    by setting this flag to \`false\`.

    If set to \`false\` then file syncing will still work but Garden will ignore
    changes to config files and services that are not in dev mode.

    This can be a performance improvement for projects that have a large number of files
    and where only file syncing is needed when in dev mode.

    Note that this flag cannot be used if hot reloading is enabled.

    This flag will be removed in future release in favour of a "smarter"
    watching mechanism.`,
  }),
}

export type DevCommandArgs = typeof devArgs
export type DevCommandOpts = typeof devOpts

// TODO: allow limiting to certain modules and/or services
export class DevCommand extends Command<DevCommandArgs, DevCommandOpts> {
  name = "dev"
  help = "Starts the garden development console."
  protected = true

  // Currently it doesn't make sense to do file watching except in the CLI
  cliOnly = true

  streamEvents = true

  description = dedent`
    The Garden dev console is a combination of the \`build\`, \`deploy\` and \`test\` commands.
    It builds, deploys and tests all your modules and services, and re-builds, re-deploys and re-tests
    as you modify the code.

    Examples:

        garden dev
        garden dev --hot=foo-service,bar-service  # enable hot reloading for foo-service and bar-service
        garden dev --hot=*                        # enable hot reloading for all compatible services
        garden dev --local=service-1,service-2    # enable local mode for service-1 and service-2
        garden dev --local=*                      # enable local mode for all compatible services
        garden dev --skip-tests=                  # skip running any tests
        garden dev --force                        # force redeploy of services when the command starts
        garden dev --name integ                   # run all tests with the name 'integ' in the project
        garden test --name integ*                 # run all tests with the name starting with 'integ' in the project
  `

  arguments = devArgs
  options = devOpts

  private garden?: Garden

  printHeader({ headerLog }) {
    printHeader(headerLog, "Dev", "keyboard")
  }

  isPersistent() {
    return true
  }

  async prepare({ headerLog, footerLog }: PrepareParams<DevCommandArgs, DevCommandOpts>) {
    // print ANSI banner image
    if (headerLog.root.type === "fancy") {
      if (chalk.supportsColor && chalk.supportsColor.level > 2) {
        const data = await readFile(ansiBannerPath)
        headerLog.info(data.toString())
      }

      headerLog.info(chalk.gray.italic(`Good ${getGreetingTime()}! Let's get your environment wired up...`))
      headerLog.info("")
    }

    this.server = await startServer({ log: footerLog })
  }

  terminate() {
    this.garden?.events.emit("_exit", {})
  }

  async action({
    garden,
    log,
    footerLog,
    args,
    opts,
  }: CommandParams<DevCommandArgs, DevCommandOpts>): Promise<CommandResult> {
    this.garden = garden
    this.server?.setGarden(garden)

    const graph = await garden.getConfigGraph({ log, emit: true })
    const modules = graph.getModules()

    const skipTests = opts["skip-tests"]

    if (modules.length === 0) {
      footerLog && footerLog.setState({ msg: "" })
      log.info({ msg: "No enabled modules found in project." })
      log.info({ msg: "Aborting..." })
      return {}
    }

    const hotReloadServiceNames = getHotReloadServiceNames(opts["hot-reload"], graph)
    if (hotReloadServiceNames.length > 0) {
      const errMsg = validateHotReloadServiceNames(hotReloadServiceNames, graph)
      if (errMsg) {
        log.error({ msg: errMsg })
        return { result: {} }
      }
    }

    const localModeServiceNames = getMatchingServiceNames(opts["local-mode"], graph)

    const services = graph.getServices({ names: args.services })

    const devModeServiceNames = services
      .map((s) => s.name)
      // Since dev mode is implicit when using this command, we consider explicitly enabling hot reloading to
      // take precedence over dev mode.
      .filter((name) => !hotReloadServiceNames.includes(name) && !localModeServiceNames.includes(name))

    if (hotReloadServiceNames.length > 0 && opts["skip-watch"]) {
      throw new ParameterError(makeSkipWatchErrorMsg(hotReloadServiceNames), {
        hotReloadServiceNames,
        options: opts,
      })
    }
    let watch = true
    if (devModeServiceNames.length > 0) {
      watch = opts["skip-watch"]
        ? false // In this case hotReloadServiceNames is empty, otherwise we throw above
        : true
    }

    const initialTasks = await getDevCommandInitialTasks({
      garden,
      log,
      graph,
      modules,
      services,
      devModeServiceNames,
      hotReloadServiceNames,
      localModeServiceNames,
      skipTests,
      forceDeploy: opts.force,
    })

    const results = await processModules({
      garden,
      graph,
      log,
      footerLog,
      modules,
      watch,
      initialTasks,
      skipWatchModules: [
        ...getModulesByServiceNames(devModeServiceNames, graph),
        ...getModulesByServiceNames(localModeServiceNames, graph),
      ],
      changeHandler: async (updatedGraph: ConfigGraph, module: GardenModule) => {
        return getDevCommandWatchTasks({
          garden,
          log,
          updatedGraph,
          module,
          servicesWatched: devModeServiceNames,
          devModeServiceNames,
          hotReloadServiceNames,
          localModeServiceNames,
          testNames: opts["test-names"],
          skipTests,
        })
      },
    })

    return handleProcessResults(footerLog, "dev", results)
  }
}

export async function getDevCommandInitialTasks({
  garden,
  log,
  graph,
  modules,
  services,
  devModeServiceNames,
  hotReloadServiceNames,
  localModeServiceNames,
  skipTests,
  forceDeploy,
}: {
  garden: Garden
  log: LogEntry
  graph: ConfigGraph
  modules: GardenModule[]
  services: GardenService[]
  devModeServiceNames: string[]
  hotReloadServiceNames: string[]
  localModeServiceNames: string[]
  skipTests: boolean
  forceDeploy: boolean
}) {
  const moduleTasks = flatten(
    await Bluebird.map(modules, async (module) => {
      // Build the module (in case there are no tests, tasks or services here that need to be run)
      const buildTasks = await BuildTask.factory({
        garden,
        graph,
        log,
        module,
        force: false,
      })

      // Run all tests in module
      const testTasks = skipTests
        ? []
        : await getTestTasks({
            garden,
            graph,
            log,
            module,
            devModeServiceNames,
            hotReloadServiceNames,
            localModeServiceNames,
            force: forceDeploy,
            forceBuild: false,
          })

      return [...buildTasks, ...testTasks]
    })
  )

  const serviceTasks = services
    .filter((s) => !s.disabled)
    .map(
      (service) =>
        new DeployTask({
          garden,
          log,
          graph,
          service,
          force: false,
          forceBuild: false,
          fromWatch: false,
          devModeServiceNames,
          hotReloadServiceNames,
          localModeServiceNames,
        })
    )

  return [...moduleTasks, ...serviceTasks]
}

export async function getDevCommandWatchTasks({
  garden,
  log,
  updatedGraph,
  module,
  servicesWatched,
  devModeServiceNames,
  hotReloadServiceNames,
  localModeServiceNames,
  testNames,
  skipTests,
}: {
  garden: Garden
  log: LogEntry
  updatedGraph: ConfigGraph
  module: GardenModule
  servicesWatched: string[]
  devModeServiceNames: string[]
  hotReloadServiceNames: string[]
  localModeServiceNames: string[]
  testNames: string[] | undefined
  skipTests: boolean
}) {
  const tasks = await getModuleWatchTasks({
    garden,
    log,
    graph: updatedGraph,
    module,
    servicesWatched,
    devModeServiceNames,
    hotReloadServiceNames,
    localModeServiceNames,
  })

  if (!skipTests) {
    const testModules: GardenModule[] = updatedGraph.withDependantModules([module])
    tasks.push(
      ...flatten(
        await Bluebird.map(testModules, (m) =>
          getTestTasks({
            garden,
            log,
            module: m,
            graph: updatedGraph,
            filterNames: testNames,
            fromWatch: true,
            devModeServiceNames,
            hotReloadServiceNames,
            localModeServiceNames,
          })
        )
      )
    )
  }

  return tasks
}

function getGreetingTime() {
  const m = moment()

  const currentHour = parseFloat(m.format("HH"))

  if (currentHour >= 17) {
    return "evening"
  } else if (currentHour >= 12) {
    return "afternoon"
  } else {
    return "morning"
  }
}
