/* eslint-disable no-console */

import { glob } from 'glob'
import { writeFile } from 'fs/promises'
import { join } from 'path'

import { tsDocgen } from './tsDocGen.js'
import { getConfig, PropsGlobs } from './getConfig.js'

async function getFiles(root: string, globs: PropsGlobs[]) {
  const files = await Promise.all(
    globs.map(async ({ include, exclude }) => {
      const files = await glob(include, { cwd: root, ignore: exclude, absolute: true })
      return files
    }),
  )
  return files.flat()
}

async function getZodSchemas(files: string[], verbose: boolean) {
  const perFileSchemas = await Promise.all(
    files.map(async (file) => {
      if (verbose) {
        console.log(`Generating Zod schemas from ${file}`)
      }

      try {
        // Get the Zod schema output for the entire file
        const zodOutput = await tsDocgen(file, 'zod') as string
        return zodOutput
      } catch (error) {
        if (verbose) {
          console.warn(`Failed to generate Zod schema for ${file}:`, error)
        }
        return ''
      }
    }),
  )

  // Filter out empty schemas
  return perFileSchemas.filter((schema) => schema.trim().length > 0)
}

export async function buildZodSchemas(
  rootDir: string,
  configFile: string,
  verbose: boolean,
  outputFile?: string,
) {
  const verboseModeLog = (...messages: any) => {
    if (verbose) {
      console.log(...messages)
    }
  }

  verboseModeLog('Beginning Zod schema generation')

  const config = await getConfig(configFile)
  if (!config) {
    console.error('No config found, please run the `setup` command or manually create a pf-docs.config.mjs file')
    return
  }

  const { propsGlobs, outputDir } = config
  if (!propsGlobs) {
    console.error('No props data found in config')
    return
  }

  const files = await getFiles(rootDir, propsGlobs)
  verboseModeLog(`Found ${files.length} files to parse`)

  const zodSchemas = await getZodSchemas(files, verbose)

  if (zodSchemas.length === 0) {
    console.warn('No Zod schemas generated')
    return
  }

  // Combine all schemas into a single file
  // Note: Each schema output already includes "import { z } from 'zod'" at the top
  // so we need to deduplicate imports
  const imports = "import { z } from 'zod'\n\n"
  const schemasWithoutImports = zodSchemas
    .map((schema) => schema.replace(/import\s*{\s*z\s*}\s*from\s*['"]zod['"]\s*\n*/g, '').trim())
    .filter((schema) => schema.length > 0)
  
  const combinedSchema = imports + schemasWithoutImports.join('\n\n')

  const schemaFile = outputFile || join(outputDir, 'schemas.ts')
  const absoluteSchemaFilePath = join(process.cwd(), schemaFile)
  
  verboseModeLog(`Writing Zod schemas to ${absoluteSchemaFilePath}`)

  await writeFile(schemaFile, combinedSchema)
  
  return absoluteSchemaFilePath
}
