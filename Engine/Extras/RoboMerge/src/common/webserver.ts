// Copyright 1998-2019 Epic Games, Inc. All Rights Reserved.
import * as util from 'util'
import * as http from 'http'
import * as https from 'https'
import {URL} from 'url'
import * as fs from 'fs'

const MIME_TYPES = new Map([
	['js', 'application/javascript'],
	['json', 'application/json'],
	['css', 'text/css'],
	['text', 'text/plain'],
	['txt', 'text/plain'],
	['html', 'text/html'],
	['png', 'image/png'],
	['jpg', 'image/jpeg']
])

export function ensureRegExp(route: RegExp | string) {
	if (route instanceof RegExp) {
		return route
	}

	// allow any character it wildcards at the moment
	// should maybe require ** to match /
	route = route
			.replace(/([().+?])/g, '\\$1')
			.replace(/\*/g, '([^/]*)')

	return new RegExp(`^${route}$`)
}

export interface RequestOpts {
	filetype?: string
	headers?: [string, string][]
	secureOnly?: boolean
}

export interface ResponseObj {
	statusCode: number
	message: string
}

export interface AppInterface {

}

export interface WebRequest {
	url: URL,
	cookies: string
	postData?: string
}

interface AppConstructor {
	new(req: WebRequest, ...extraArgs: any[]): AppInterface
}

type MakeApp = (req: WebRequest) => AppInterface

export type Response = ResponseObj | string;

// Take the verb, route and content type arguments from the decorator and add
// them to the class methods
// (calling HTTP methods 'verb's and class methods 'func's to distinguish)
export function Handler(verb: string, route: RegExp | string, opts?: RequestOpts) {
	return (_target: AppInterface, _funcName: string, desc: PropertyDescriptor) => {
		desc.value.verb = verb
		desc.value.route = ensureRegExp(route)
		if (opts) {
			desc.value.opts = opts
		}
		return desc
	}
}

type HandlerFunc = (res: http.ServerResponse, req: WebRequest, match: string[]) => any

interface HandlerInternal
{
	route: RegExp
	verb: string
	handler: HandlerFunc
	secureOnly: boolean
}

export interface CertFiles {
	key: string
	cert: string
}

export class WebServer {
	protected server: http.Server | https.Server | null

	public secure = false

	temp_debug_id: number

	addApp(appType: AppConstructor, inMakeApp?: MakeApp) {
		const makeApp = inMakeApp || ((request: WebRequest) => new appType(request))

		// add handlers registered by decorator
		// (for now priority is based on order)

		const proto = appType.prototype;
		for (const propName of Object.getOwnPropertyNames(proto)) {
			const prop = (<any>proto)[propName]
			if (prop.route && prop.verb) {
				// @todo more logging of incorrect stuff

				this.handlers.push({
					route: prop.route,
					verb: prop.verb,
					handler: (response: http.ServerResponse, req: WebRequest, match: string[]) => 
						this.handleCustomRequest(makeApp(req), response, req, prop, match),
					secureOnly: prop.opts && prop.opts.secureOnly
				})
			}
		}
	}

	open(optPort?: number, protocol?: string, certFiles?: CertFiles) {
		if (this.server) {
			throw new Error('already open')
		}

		protocol = protocol || 'https'
		this.secure = protocol.toLowerCase() !== 'http'
		const port = optPort || (this.secure ? 443 : 80)


		if (this.secure) {
			// cast because @types/node doesn't seem to know about this constructor
			this.server = new (https.Server as any)(certFiles!)
		}
		else {
			this.server = new http.Server
		}

		this.server!.on('request', (request, response) => this.onRequest(request, response))

		util.log(`Web server listening on port ${port} over ${protocol}`)
		return new Promise<void>((done, _fail) => this.server!.listen(port, done))
	}

	async close() {
		if (this.server) {
			// close the server to new connections
			await new Promise<void>((done, _fail) => this.server!.close(done))
			this.server = null
		}
	}

	addFileMapping(route: string | RegExp, filePattern: string, opts?: RequestOpts) {
		let filetype = opts && opts.filetype;
		if (!filetype) {
			if (!(route instanceof RegExp)) {
				const lastDotIndex = route.lastIndexOf('.')
				if (lastDotIndex !== -1) {
					filetype = route.substr(lastDotIndex + 1)
				}
			}
		}

		if (!filetype) {
			const lastDotIndex = filePattern.lastIndexOf('.')
			if (lastDotIndex === -1) {
				throw new Error('File type or file extension required')
			}
			filetype = filePattern.substr(lastDotIndex + 1)
		}
		if (!MIME_TYPES.has(filetype) && filetype.split('/').length !== 2) {
			throw new Error(`Unknown file type '${filetype}'`)
		}

		let encoding: string | null = null
		let mimeType = MIME_TYPES.get(filetype)
		if (mimeType) {
			// assuming known file types other than images are text
			// HACK HACK HACK - any headers currently turn off utf8 decoding
			if (!mimeType.startsWith('image/') && !(opts && 'headers' in opts)) {
				encoding = 'utf8'
			}
		}
		else {
			mimeType = filetype
		}

		const routeRegExp = ensureRegExp(route)
		this.handlers.push({
			route: routeRegExp,
			verb: 'GET',

// handler: (response: http.ServerResponse, req: WebRequest, match: string[]) => 
// 	this.handleCustomRequest(makeApp(req.path, req.cookies), response, req, prop, match),

			handler: (response: http.ServerResponse, req: WebRequest, _match: string[]) =>
				this.handleFileRequest(response, filePattern, encoding, mimeType!, routeRegExp, req.url.pathname!, opts && opts.headers),
			secureOnly: !!(opts && opts.secureOnly)
		})
	}

	public addHandler(route: RegExp | string, verb: string, handler: HandlerFunc, opts?: RequestOpts) {
		this.handlers.push({route: ensureRegExp(route), verb: verb, handler: handler, secureOnly: !!(opts && opts.secureOnly)})
	}

	public static writeJSONOrText(response: http.ServerResponse, result: any) {
		if (typeof(result) === 'object') {
			response.writeHead(200, {'Content-Type': 'application/json'})
			response.end(JSON.stringify(result, null, '  '))
		}
		else {
			response.writeHead(200, {'Content-Type': 'text/plain'})
			response.end(result.toString())
		}
	}

	private static makeHeadersObject(kvs: [string, string][]) {
		const headers: any = {};
		for (const [k, v] of kvs) {
			headers[k] = v;
		}
		return headers;	
	}

	private handleFileRequest(response: http.ServerResponse, filePattern: string, encoding: string | null,
								mimeType: string, route: RegExp, path: string, inHeaders?: [string, string][]) {
		const filePath = path.replace(route, filePattern)
		if (filePath.search(/\.\./) !== -1) {
			throw new Error('relative paths not allowed!')
		}

		// serve the file
		fs.readFile('./public/' + filePath, encoding, (err, data) => {
			if (err) {
				response.writeHead(404)
				response.end(`File not found: ${filePath}`)
			}
			else {
				const headers = inHeaders ? WebServer.makeHeadersObject(inHeaders) : {};
				headers['Content-Type'] = mimeType;
				response.writeHead(200, headers)
				response.end(data)
			}
		})
	}

	private async handleCustomRequest(app: AppInterface, response: http.ServerResponse, _req: WebRequest, prop: Function, match: string[]) {

		let result;
		try {
			result = await prop.call(app, ...match.slice(1))
		}
		catch (err) {
			response.writeHead(500)
			response.end(`Error handling not implemented yet: ${err.toString()}`)
			return
		}

		const opts = (prop as any).opts
		const headersArray = result.headers || (opts && opts.headers)
		const headers: any = headersArray ? WebServer.makeHeadersObject(headersArray) : {};

		const code = result.statusCode || 200;
		const content = result.message || result;


		if (code === 200) {
			if (opts && opts.filetype) {
				headers['Content-Type'] = opts.filetype
				response.writeHead(code, headers)
				response.write(content, 'binary')
				response.end(null, 'binary')
				return
			}
			if (typeof(content) === 'object') {
				headers['Content-Type'] = 'application/json'
				response.writeHead(code, headers)
				response.end(JSON.stringify(content, null, '  '))
				return
			}
		}

		headers['Content-Type'] = 'text/plain'
		response.writeHead(code, headers)
		response.end(content.toString())
	}

	private readPostData(req: http.IncomingMessage) {
		return new Promise<string>((done, _fail) => {
			// assuming text or base64 post data
			let postData = ''
			req.on('data', (chunk: Buffer) => {
				postData += chunk.toString('utf8')
			})

			req.on('end', () => done(postData))
		});
	}

	private async onRequest(req: http.IncomingMessage, response: http.ServerResponse) {
		let url = null
		try {
			url = new URL(`http${this.secure ? 's' : ''}://${req.headers.host}${req.url!}`)
		}
		catch (err) {
			util.log('Request error: ' + err.toString())
		}

		if (!url || !url.pathname) {
			response.writeHead(500)
			response.end('URL parse failure')
			return
		}

		let postData = ''
		if (req.method === 'POST') {
			postData = await this.readPostData(req)
		}

		for (const handler of this.handlers) {
			if (req.method !== handler.verb || (handler.secureOnly && !this.secure)) {
				continue
			}

			const match = url.pathname.match(handler.route)
			if (match) {
				try {
					await handler.handler(response, {url: url, cookies: req.headers.cookie as string, postData: postData}, match)
				}
				catch (err) {
					response.writeHead(500)
					response.end(`Internal server error: ${err.toString()}`)
				}
				return
			}
		}

		response.writeHead(404)
		response.end('Resource not found')
	}

	private handlers: HandlerInternal[] = []
}
