/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'path'
import { webpack, sources } from 'next/dist/compiled/webpack/webpack'
import {
  CLIENT_REFERENCE_MANIFEST,
  SYSTEM_ENTRYPOINTS,
} from '../../../shared/lib/constants'
import { relative, sep } from 'path'
import { isClientComponentModule, regexCSS } from '../loaders/utils'
import { getProxiedPluginState } from '../../build-context'

import { traverseModules } from '../utils'
import { nonNullable } from '../../../lib/non-nullable'
import { WEBPACK_LAYERS } from '../../../lib/constants'

interface Options {
  dev: boolean
  appDir: string
}

/**
 * Webpack module id
 */
// TODO-APP ensure `null` is included as it is used.
type ModuleId = string | number /*| null*/

export type ManifestChunks = Array<`${string}:${string}` | string>

const pluginState = getProxiedPluginState({
  serverModuleIds: {} as Record<string, string | number>,
  edgeServerModuleIds: {} as Record<string, string | number>,
  ASYNC_CLIENT_MODULES: [] as string[],
})

interface ManifestNode {
  [moduleExport: string]: {
    /**
     * Webpack module id
     */
    id: ModuleId
    /**
     * Export name
     */
    name: string
    /**
     * Chunks for the module. JS and CSS.
     */
    chunks: ManifestChunks

    /**
     * If chunk contains async module
     */
    async?: boolean
  }
}

export type FlightManifest = {
  __ssr_module_mapping__: {
    [modulePath: string]: ManifestNode
  }
  __edge_ssr_module_mapping__: {
    [modulePath: string]: ManifestNode
  }
  __entry_css_files__: {
    [entryPathWithoutExtension: string]: string[]
  }
} & ManifestNode

export type FlightCSSManifest = {
  [modulePath: string]: string[]
} & {
  __entry_css_mods__?: {
    [entry: string]: string[]
  }
}

const PLUGIN_NAME = 'FlightManifestPlugin'

export class FlightManifestPlugin {
  dev: Options['dev'] = false
  appDir: Options['appDir']
  ASYNC_CLIENT_MODULES: Set<string>

  constructor(options: Options) {
    this.dev = options.dev
    this.appDir = options.appDir
    this.ASYNC_CLIENT_MODULES = new Set(pluginState.ASYNC_CLIENT_MODULES)
  }

  apply(compiler: webpack.Compiler) {
    compiler.hooks.compilation.tap(
      PLUGIN_NAME,
      (compilation, { normalModuleFactory }) => {
        compilation.dependencyFactories.set(
          webpack.dependencies.ModuleDependency,
          normalModuleFactory
        )
        compilation.dependencyTemplates.set(
          webpack.dependencies.ModuleDependency,
          new webpack.dependencies.NullDependency.Template()
        )
      }
    )

    compiler.hooks.make.tap(PLUGIN_NAME, (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: PLUGIN_NAME,
          // Have to be in the optimize stage to run after updating the CSS
          // asset hash via extract mini css plugin.
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH,
        },
        (assets) => this.createAsset(assets, compilation, compiler.context)
      )
    })
  }

  createAsset(
    assets: webpack.Compilation['assets'],
    compilation: webpack.Compilation,
    context: string
  ) {
    // @ts-ignore
    const manifest: FlightManifest = {
      __ssr_module_mapping__: {},
      __edge_ssr_module_mapping__: {},
      __entry_css_files__: {},
    }
    const dev = this.dev

    const clientRequestsSet = new Set()

    // Collect client requests
    function collectClientRequest(mod: webpack.NormalModule) {
      if (mod.resource === '' && mod.buildInfo.rsc) {
        const { requests = [] } = mod.buildInfo.rsc
        requests.forEach((r: string) => {
          clientRequestsSet.add(r)
        })
      }
    }

    traverseModules(compilation, (mod) => collectClientRequest(mod))

    compilation.chunkGroups.forEach((chunkGroup) => {
      const recordModule = (
        id: ModuleId,
        mod: webpack.NormalModule,
        chunkCSS: string[]
      ) => {
        const isCSSModule =
          regexCSS.test(mod.resource) ||
          mod.type === 'css/mini-extract' ||
          (!!mod.loaders &&
            (dev
              ? mod.loaders.some((item) =>
                  item.loader.includes('next-style-loader/index.js')
                )
              : mod.loaders.some((item) =>
                  item.loader.includes('mini-css-extract-plugin/loader.js')
                )))

        // Skip all modules from the pages folder. CSS modules are a special case
        // as they are generated by mini-css-extract-plugin and these modules
        // don't have layer information attached.
        if (!isCSSModule && mod.layer !== WEBPACK_LAYERS.appClient) {
          return
        }

        const resource =
          mod.type === 'css/mini-extract'
            ? // @ts-expect-error TODO: use `identifier()` instead.
              mod._identifier.slice(mod._identifier.lastIndexOf('!') + 1)
            : mod.resource

        if (!resource) {
          return
        }

        const moduleIdMapping = manifest.__ssr_module_mapping__
        const edgeModuleIdMapping = manifest.__edge_ssr_module_mapping__

        // Note that this isn't that reliable as webpack is still possible to assign
        // additional queries to make sure there's no conflict even using the `named`
        // module ID strategy.
        let ssrNamedModuleId = relative(
          context,
          mod.resourceResolveData?.path || resource
        )

        if (!ssrNamedModuleId.startsWith('.'))
          ssrNamedModuleId = `./${ssrNamedModuleId.replace(/\\/g, '/')}`

        if (isCSSModule) {
          if (!manifest[resource + '#']) {
            manifest[resource + '#'] = {
              id: id || '',
              name: '',
              chunks: chunkCSS,
            }
          } else {
            // It is possible that there are multiple modules with the same resource,
            // e.g. extracted by mini-css-extract-plugin. In that case we need to
            // merge the chunks.
            manifest[resource + '#'].chunks = [
              ...new Set([...manifest[resource + '#'].chunks, ...chunkCSS]),
            ]
          }

          return
        }

        // Only apply following logic to client module requests from client entry,
        // or if the module is marked as client module.
        if (!clientRequestsSet.has(resource) && !isClientComponentModule(mod)) {
          return
        }

        const exportsInfo = compilation.moduleGraph.getExportsInfo(mod)
        const isAsyncModule = this.ASYNC_CLIENT_MODULES.has(mod.resource)

        const cjsExports = [
          ...new Set(
            [
              ...mod.dependencies.map((dep) => {
                // Match CommonJsSelfReferenceDependency
                if (dep.type === 'cjs self exports reference') {
                  // @ts-expect-error: TODO: Fix Dependency type
                  if (dep.base === 'module.exports') {
                    return 'default'
                  }

                  // `exports.foo = ...`, `exports.default = ...`
                  // @ts-expect-error: TODO: Fix Dependency type
                  if (dep.base === 'exports') {
                    // @ts-expect-error: TODO: Fix Dependency type
                    return dep.names.filter(
                      (name: any) => name !== '__esModule'
                    )
                  }
                }
                return null
              }),
            ].flat()
          ),
        ]

        function getAppPathRequiredChunks() {
          return chunkGroup.chunks
            .map((requiredChunk: webpack.Chunk) => {
              if (SYSTEM_ENTRYPOINTS.has(requiredChunk.name)) {
                return null
              }

              return (
                requiredChunk.id +
                ':' +
                (requiredChunk.name || requiredChunk.id) +
                (dev ? '' : '-' + requiredChunk.hash)
              )
            })
            .filter(nonNullable)
        }
        const requiredChunks = getAppPathRequiredChunks()

        // The client compiler will always use the CJS Next.js build, so here we
        // also add the mapping for the ESM build (Edge runtime) to consume.
        const esmResource = /[\\/]next[\\/]dist[\\/]/.test(resource)
          ? resource.replace(
              /[\\/]next[\\/]dist[\\/]/,
              '/next/dist/esm/'.replace(/\//g, path.sep)
            )
          : null

        function addClientReference(name: string) {
          if (name === '*') {
            manifest[resource] = {
              id,
              chunks: requiredChunks,
              name: '*',
              async: isAsyncModule,
            }
            if (esmResource) {
              manifest[esmResource] = manifest[resource]
            }
          } else if (name === '') {
            manifest[resource + '#'] = {
              id,
              chunks: requiredChunks,
              name: '',
              async: isAsyncModule,
            }
            if (esmResource) {
              manifest[esmResource + '#'] = manifest[resource + '#']
            }
          } else {
            manifest[resource + '#' + name] = {
              id,
              chunks: requiredChunks,
              name,
              async: isAsyncModule,
            }
            if (esmResource) {
              manifest[esmResource + '#' + name] =
                manifest[resource + '#' + name]
            }
          }
        }

        function addSSRIdMapping(name: string) {
          const key = resource + (name === '*' ? '' : '#' + name)
          if (
            typeof pluginState.serverModuleIds[ssrNamedModuleId] !== 'undefined'
          ) {
            moduleIdMapping[id] = moduleIdMapping[id] || {}
            moduleIdMapping[id][name] = {
              ...manifest[key],
              id: pluginState.serverModuleIds[ssrNamedModuleId],
            }
          }

          if (
            typeof pluginState.edgeServerModuleIds[ssrNamedModuleId] !==
            'undefined'
          ) {
            edgeModuleIdMapping[id] = edgeModuleIdMapping[id] || {}
            edgeModuleIdMapping[id][name] = {
              ...manifest[key],
              id: pluginState.edgeServerModuleIds[ssrNamedModuleId],
            }
          }
        }

        addClientReference('*')
        addClientReference('')
        addSSRIdMapping('*')
        addSSRIdMapping('')

        const moduleExportedKeys = [
          ...[...exportsInfo.exports]
            .filter((exportInfo) => exportInfo.provided)
            .map((exportInfo) => exportInfo.name),
          ...cjsExports,
        ].filter((name) => name !== null)

        moduleExportedKeys.forEach((name) => {
          const key = resource + '#' + name

          // If the chunk is from `app/` chunkGroup, use it first.
          // This make sure not to load the overlapped chunk from `pages/` chunkGroup
          if (
            !manifest[key] ||
            (chunkGroup.name && /^app[\\/]/.test(chunkGroup.name))
          ) {
            addClientReference(name)
          }

          addSSRIdMapping(name)
        })

        manifest.__ssr_module_mapping__ = moduleIdMapping
        manifest.__edge_ssr_module_mapping__ = edgeModuleIdMapping
      }

      chunkGroup.chunks.forEach((chunk: webpack.Chunk) => {
        const chunkModules = compilation.chunkGraph.getChunkModulesIterable(
          chunk
          // TODO: Update type so that it doesn't have to be cast.
        ) as Iterable<webpack.NormalModule>

        const chunkCSS = [...chunk.files].filter(
          (f) => !f.startsWith('static/css/pages/') && f.endsWith('.css')
        )

        for (const mod of chunkModules) {
          const modId: string = compilation.chunkGraph.getModuleId(mod) + ''

          recordModule(modId, mod, chunkCSS)

          // If this is a concatenation, register each child to the parent ID.
          // TODO: remove any
          const anyModule = mod as any
          if (anyModule.modules) {
            anyModule.modules.forEach((concatenatedMod: any) => {
              recordModule(modId, concatenatedMod, chunkCSS)
            })
          }
        }
      })

      const entryCSSFiles: any = manifest.__entry_css_files__ || {}

      const addCSSFilesToEntry = (
        files: string[],
        entryName: string | undefined | null
      ) => {
        if (entryName?.startsWith('app/')) {
          // The `key` here should be the absolute file path but without extension.
          // We need to replace the separator in the entry name to match the system separator.
          const key =
            this.appDir +
            entryName
              .slice(3)
              .replace(/\//g, sep)
              .replace(/\.[^\\/.]+$/, '')
          entryCSSFiles[key] = files.concat(entryCSSFiles[key] || [])
        }
      }

      const cssFiles = chunkGroup.getFiles().filter((f) => f.endsWith('.css'))

      if (cssFiles.length) {
        // Add to chunk entry and parent chunk groups too.
        addCSSFilesToEntry(cssFiles, chunkGroup.name)
        chunkGroup.getParents().forEach((parent) => {
          addCSSFilesToEntry(cssFiles, parent.options.name)
        })
      }

      manifest.__entry_css_files__ = entryCSSFiles
    })

    const file = 'server/' + CLIENT_REFERENCE_MANIFEST
    const json = JSON.stringify(manifest, null, this.dev ? 2 : undefined)

    pluginState.ASYNC_CLIENT_MODULES = []

    assets[file + '.js'] = new sources.RawSource(
      'self.__RSC_MANIFEST=' + json
      // Work around webpack 4 type of RawSource being used
      // TODO: use webpack 5 type by default
    ) as unknown as webpack.sources.RawSource
    assets[file + '.json'] = new sources.RawSource(
      json
      // Work around webpack 4 type of RawSource being used
      // TODO: use webpack 5 type by default
    ) as unknown as webpack.sources.RawSource
  }
}
