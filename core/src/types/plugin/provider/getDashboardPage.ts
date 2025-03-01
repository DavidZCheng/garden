/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { PluginActionParamsBase, actionParamsSchema } from "../base"
import { dedent } from "../../../util/string"
import { joi, joiIdentifier, joiArray } from "../../../config/common"

export interface DashboardPage {
  name: string
  title: string
  description: string
  url?: string
  newWindow: boolean
  // TODO: allow nested sections
  // children: DashboardPage[]
}

export const dashboardPageSchema = () =>
  joi.object().keys({
    name: joiIdentifier().required().description("A unique identifier for the page."),
    title: joi.string().max(32).required().description("The link title to show in the menu bar (max length 32)."),
    description: joi.string().required().description("A description to show when hovering over the link."),
    url: joi
      .string()
      .uri()
      .description(
        "The URL to open in the dashboard pane when clicking the link. If none is specified, the provider must specify a `getDashboardPage` handler that resolves the URL given the `name` of this page."
      ),
    newWindow: joi
      .boolean()
      .default(false)
      .description("Set to true if the link should open in a new browser tab/window."),
  })

export const dashboardPagesSchema = () =>
  joiArray(dashboardPageSchema())
    .optional()
    .description("A list of pages that the provider adds to the Garden dashboard.")
    .unique("name")

export interface GetDashboardPageParams extends PluginActionParamsBase {
  page: DashboardPage
}

export interface GetDashboardPageResult {
  url: string
}

export const getDashboardPage = () => ({
  description: dedent`
    Given one of the \`dashboardPages\` configured on the provider, resolve the name/spec into a URL. This is useful to allow for dynamically generated URLs, and to start any on-demand processes required to serve the page.

    The API server will call this handler when the page is requested, and then redirect the request to the returned URL after the handler returns.
  `,
  paramsSchema: actionParamsSchema().keys({
    page: dashboardPageSchema(),
  }),
  resultSchema: joi.object().keys({
    url: joi.string().uri().required().description("The URL where the dashboard page is accessible."),
  }),
})
