import { readFile } from 'fs/promises'
import { parse } from 'react-docgen'
import ts from 'typescript'

const annotations = [
  {
    regex: /@deprecated/,
    name: 'deprecated',
    type: 'Boolean',
  },
  {
    regex: /@hide/,
    name: 'hide',
    type: 'Boolean',
  },
  {
    regex: /@beta/,
    name: 'beta',
    type: 'Boolean',
  },
  {
    regex: /@propType\s+(.*)/,
    name: 'type',
    type: 'String',
  },
]

function addAnnotations(prop) {
  if (prop.description) {
    annotations.forEach(({ regex, name }) => {
      const match = prop.description.match(regex)
      if (match) {
        prop.description = prop.description.replace(regex, '').trim()
        if (name) {
          prop[name] = match[2] || match[1] || true
        }
      }
    })
  }

  return prop
}

function getComponentMetadata(filename, sourceText) {
  let parsedComponents = null
  try {
    parsedComponents = parse(sourceText, { filename })
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_err) {
    // console.warn(`No component found in ${filename}:`, err);
  }

  return (parsedComponents || []).filter(
    (parsed) => parsed && parsed.displayName,
  )
}

const getNodeText = (node, sourceText) => {
  if (!node || !node.pos || !node.end) {
    return undefined
  }

  return sourceText.substring(node.pos, node.end).trim()
}

const buildJsDocProps = (nodes, sourceText) =>
  nodes?.reduce((acc, member) => {
    const name =
      (member.name && member.name.escapedText) ||
      (member.parameters &&
        `[${getNodeText(member.parameters[0], sourceText)}]`) ||
      'Unknown'
    acc[name] = {
      description: member.jsDoc
        ? member.jsDoc.map((doc) => doc.comment).join('\n')
        : null,
      required: member.questionToken === undefined,
      type: {
        raw: getNodeText(member.type, sourceText).trim(),
      },
    }
    return acc
  }, {})

const getSourceFileStatements = (filename, sourceText) => {
  const { statements } = ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest, // languageVersion
  )

  return statements
}

const getInterfaceMetadata = (filename, sourceText) =>
  getSourceFileStatements(filename, sourceText).reduce(
    (metaDataAcc, statement) => {
      if (statement.kind === ts.SyntaxKind.InterfaceDeclaration) {
        const _statement = statement
        metaDataAcc.push({
          displayName: _statement.name.escapedText,
          description: _statement.jsDoc?.map((doc) => doc.comment).join('\n'),
          props: buildJsDocProps(_statement.members, sourceText),
        })
      }

      return metaDataAcc
    },
    [],
  )

const getTypeAliasMetadata = (filename, sourceText) =>
  getSourceFileStatements(filename, sourceText).reduce(
    (metaDataAcc, statement) => {
      if (statement.kind === ts.SyntaxKind.TypeAliasDeclaration) {
        const _statement = statement
        const props = _statement.type.types?.reduce((propAcc, type) => {
          if (type.members) {
            propAcc.push(buildJsDocProps(type.members, sourceText))
          }

          return propAcc
        }, [])

        metaDataAcc.push({
          props,
          displayName: _statement.name.escapedText,
          description: _statement.jsDoc?.map((doc) => doc.comment).join('\n'),
        })
      }

      return metaDataAcc
    },
    [],
  )

function extractEnumValues(typeString) {
  if (!typeString || typeof typeString !== 'string') {
    return []
  }
  
  // Handle union types like 'primary' | 'secondary' | 'tertiary'
  if (typeString.includes('|')) {
    return typeString
      .split('|')
      .map(value => value.trim())
      .filter(value => value.startsWith("'") || value.startsWith('"'))
      .map(value => value.slice(1, -1)) // Remove quotes
      .filter(value => value.length > 0)
  }
  
  return []
}

function mapTypeToZod(typeString, enumValues, defaultValue, required = true) {
  let zodType = 'z.any()'
  
  // Handle enum/union types first
  if (enumValues && enumValues.length > 0) {
    const enumString = enumValues.map(val => `'${val}'`).join(', ')
    zodType = `z.enum([${enumString}])`
  }
  // Handle union types with numbers (like 0 | 1 | 2 | 3)
  else if (typeString.includes('|') && /\d/.test(typeString)) {
    const values = typeString.split('|').map(v => v.trim())
    const allNumbers = values.every(v => !isNaN(Number(v)))
    if (allNumbers) {
      zodType = `z.union([${values.map(v => `z.literal(${v})`).join(', ')}])`
    } else {
      zodType = 'z.any()'
    }
  }
  // Handle basic types
  else if (typeString.includes('string') || typeString === 'string') {
    zodType = 'z.string()'
  }
  else if (typeString.includes('number') || typeString === 'number') {
    zodType = 'z.number()'
  }
  else if (typeString.includes('boolean') || typeString === 'boolean') {
    zodType = 'z.boolean()'
  }
  else if (typeString.includes('Date') || typeString === 'Date') {
    zodType = 'z.date()'
  }
  // Handle array types
  else if (typeString.includes('[]') || typeString.includes('Array<')) {
    const baseType = typeString.replace(/\[\]|Array<|>/g, '').trim()
    const innerZodType = mapTypeToZod(baseType, null, null, true).replace(/\.optional\(\)|\.default\([^)]*\)/g, '')
    zodType = `z.array(${innerZodType})`
  }
  // Handle React types
  else if (typeString.includes('ReactNode') || typeString.includes('React.ReactNode')) {
    zodType = 'z.any()'
  }
  else if (typeString.includes('ReactElement') || typeString.includes('React.ReactElement')) {
    zodType = 'z.any()'
  }
  else if (typeString.includes('MouseEvent') || typeString.includes('KeyboardEvent') || typeString.includes('Event')) {
    zodType = 'z.any()'
  }
  // Handle function types
  else if (typeString.includes('=>') || typeString.includes('function') || typeString.includes('Function')) {
    zodType = 'z.function()'
  }
  // Handle object types
  else if (typeString.includes('{') && typeString.includes('}')) {
    zodType = 'z.object({})'
  }
  // Handle undefined/null
  else if (typeString === 'undefined') {
    zodType = 'z.undefined()'
  }
  else if (typeString === 'null') {
    zodType = 'z.null()'
  }
  
  // Add optional modifier if not required
  if (!required) {
    zodType += '.optional()'
  }
  
  // Add default value if provided
  if (defaultValue !== undefined && defaultValue !== null) {
    // Handle different default value types
    if (typeof defaultValue === 'string') {
      // Remove surrounding quotes if they exist
      const cleanValue = defaultValue.replace(/^['"]|['"]$/g, '')
      
      if (cleanValue === 'true' || cleanValue === 'false') {
        zodType += `.default(${cleanValue})`
      } else if (!isNaN(Number(cleanValue)) && cleanValue !== '') {
        zodType += `.default(${cleanValue})`
      } else {
        // For string values, use single quotes
        zodType += `.default('${cleanValue}')`
      }
    } else {
      zodType += `.default(${defaultValue})`
    }
  }
  
  return zodType
}

function generateZodSchemaFromProps(props, componentName) {
  if (!props || props.length === 0) {
    return `export const ${componentName}Schema = z.object({})`
  }
  
  const propSchemas = props.map(prop => {
    // If required is not explicitly set to true, treat it as optional
    const isRequired = prop.required === true
    const zodType = mapTypeToZod(prop.type, prop.enumValues, prop.defaultValue, isRequired)
    // Handle special prop names like aria-label by quoting them
    const needsQuotes = prop.name.includes('-') || prop.name === 'Unknown' || !prop.name.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/)
    const propName = needsQuotes ? `'${prop.name}'` : prop.name
    return `  ${propName}: ${zodType}`
  })
  
  return `export const ${componentName}Schema = z.object({\n${propSchemas.join(',\n')}\n})`
}

function generateZodOutput(parsedData) {
  const imports = "import { z } from 'zod'\n\n"
  
  const schemas = parsedData.map(({ name, props }) => 
    generateZodSchemaFromProps(props, name)
  ).join('\n\n')
  
  const typeExports = parsedData.map(({ name }) => 
    `export type ${name} = z.infer<typeof ${name}Schema>`
  ).join('\n')
  
  return `${imports}${schemas}\n\n${typeExports}\n`
}

function normalizeProp([
  name,
  { required, annotatedType, type, tsType, description, defaultValue },
]) {
  const typeString = 
    annotatedType ||
    (type && type.name) ||
    (type && (type.raw || type.name)) ||
    (tsType && (tsType.raw || tsType.name)) ||
    'No type info'
    
  const res = {
    name,
    type: typeString,
    description,
  }
  
  // Extract enum values for union types
  const enumValues = extractEnumValues(typeString)
  if (enumValues.length > 0) {
    res.enumValues = enumValues
  }
  
  if (required) {
    res.required = true
  }
  if (defaultValue && defaultValue.value) {
    res.defaultValue = defaultValue.value
  }

  return res
}

export async function tsDocgen(file, outputFormat = 'json') {
  const sourceText = await readFile(file, 'utf8')
  const componentMeta = getComponentMetadata(file, sourceText) // Array of components with props
  const interfaceMeta = getInterfaceMetadata(file, sourceText) // Array of interfaces with props
  const typeAliasMeta = getTypeAliasMetadata(file, sourceText) // Array of type aliases with props
  const propsMetaMap = [...interfaceMeta, ...typeAliasMeta].reduce(function (
    target,
    interfaceOrTypeAlias,
  ) {
    target[interfaceOrTypeAlias.displayName] = interfaceOrTypeAlias
    return target
  }, {})

  // Go through each component and check if they have an interface or type alias with a jsDoc description
  // If so copy it over (fix for https://github.com/patternfly/patternfly-react/issues/7612)
  componentMeta.forEach((c) => {
    if (c.description) {
      return c
    }

    const propsName = `${c.displayName}Props`
    if (propsMetaMap[propsName]?.description) {
      c.description = propsMetaMap[propsName].description
    }
  })

  const allParsed = [...componentMeta, ...interfaceMeta, ...typeAliasMeta]
  
  // For Zod output, filter out components that have a matching interface
  // This prevents duplicate schemas and prefers interface definitions over component implementations
  const parsedToUse = outputFormat === 'zod' 
    ? allParsed.filter((parsed, index, array) => {
        // If this is a component, check if a matching Props interface exists
        const isComponent = componentMeta.includes(parsed)
        if (isComponent) {
          const interfaceName = `${parsed.displayName}Props`
          const hasMatchingInterface = array.some(p => p.displayName === interfaceName)
          if (hasMatchingInterface) {
            return false // Skip component, keep interface instead
          }
        }
        return true
      })
    : allParsed

  const parsedData = parsedToUse.map(
    (parsed) => ({
      name: parsed.displayName,
      description: parsed.description || '',
      props: Object.entries(parsed.props || {})
        .map(normalizeProp)
        .map(addAnnotations)
        .filter((prop) => !prop.hide)
        .sort((p1, p2) => p1.name.localeCompare(p2.name)),
    }),
  )

  // Return different formats based on outputFormat parameter
  if (outputFormat === 'zod') {
    return generateZodOutput(parsedData)
  }
  
  return parsedData
}
