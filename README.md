<div align="center">
<a href="http://localhost:3000/"><img width="500" src="resources/ecomapi.png" alt="ecompi logo placeholder"></a>

<h4 align="center">RESTful and experimental API for E-commerce websites</h4>
<p align="center">
	<a href="#"><img src="https://github.com/sinkaroid/lustpress/workflows/Playground/badge.svg" alt="Build Status"></a>
	<a href="#"><img src="https://api.codeclimate.com/v1/badges/29a2be78f853f9e3a4a3/maintainability" alt="Maintainability" /></a>
</p>

Ecompi stands for **Ecom**merce and A**PI**, built from the necessity of reliable extraction with a completely modular approach.
The motivation of this project is to bring you actionable data related to Blibli (and other online marketplaces) with a unified, similar design pattern, seamless endpoint bindings, and consistent structure in mind.

<a href="#playground">Playground</a> •
<a href="#contributing">Contributing</a> •
<a href="#report-issues">Report Issues</a>
</div>

---

- [The problem](#the-problem)
- [The solution](#the-solution)
- [Features](#features)
- [Supported Marketplaces](#supported-marketplaces)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Docker](#docker)
  - [Docker (adjust your own)](#docker-adjust-your-own)
  - [Manual](#manual)
- [Playground](#playground)
  - [Blibli](#blibli)
- [Status response](#status-response)
- [Pronunciation](#pronunciation)
- [Legal](#legal)


## The problem

Many developers consume e-commerce websites as a source of pricing data, product catalogs, and market research when building applications. However, most of these sites — such as Blibli, Tokopedia, and others — do not provide official public APIs and are heavily guarded by enterprise anti-bot protections (like Cloudflare Enterprise and Akamai).

As a result, developers often need to implement their own complex scraping logic, maintain fragile DOM parsers, and constantly update custom bypass mechanisms for each individual site.

Ecompi aims to simplify this process by providing a unified interface for accessing data across multiple e-commerce platforms. Instead of maintaining separate bypass implementations, developers can rely on Ecompi's stealth `BrowserPool` and modular architecture to reduce complexity and development overhead.

## The solution
Don't make it long, make it short. All processed through single REST endpoint bindings using a headless browser engine that intercepts internal API calls rather than parsing raw, easily-broken HTML.

## Features

- Aggregates data from multiple e-commerce sites modularly.
- Provides a consistent and structured response format across all sources.
- Stealth browser engine (Playwright) bypasses advanced bot mitigation automatically.
- Unified interface supporting **get (product)**, **search**, and **categories** methods.
- Built-in dual-layer caching (Redis + In-memory) to prevent rate-limiting from target sites.
- Zod-schema validations guarantee consistent response shapes.

## Supported Marketplaces
Some endpoints may fail depending on the target's bot-mitigation updates. We are constantly trying to keep up.

| Site            | Status                                                                    | Product Details | Search | Categories |
| --------------- | ------------------------------------------------------------------------- | --- | ------ | ------ |
| `blibli`        | [blibli](https://blibli.com)  | `Yes`  | `Yes`     | `Yes`     |
| `tokopedia`     | `Coming Soon`                                                           | `TBD`  | `TBD`     | `TBD`     |
| `shopee`        | `Coming Soon`                                                           | `TBD`  | `TBD`     | `TBD`     |

## Prerequisites
<table>
	<td><b>NOTE:</b> NodeJS 22.x or higher</td>
</table>

To handle multiple heavy browser requests efficiently, you will also need [Redis](https://redis.io/) for persistent caching and rate-limiting. A free tier is available on Redis Labs. Playwright dependencies (Chromium) must also be installed on your environment.

## Installation
Rename `.env.example` to `.env` and fill the value with your own configurations.

```bash
# default port
PORT = 3000

# backend storage, default is redis, if not set it will consume memory storage
REDIS_URL = redis://localhost:6379

# Run browser stealth engine in headless mode
BROWSER_HEADLESS = true

# Max requests per window
RATE_LIMIT_MAX = 30
```

### Docker

You can easily pull or build the container. Assuming you build it locally:
```bash
docker-compose up -d --build
```

### Docker (adjust your own)
```bash
docker run -d \
  --name=ecompi \
  -p 3000:3000 \
  -e REDIS_URL='redis://default:somenicepassword@redis-uri:1337' \
  -e BROWSER_HEADLESS='true' \
  ecompi:latest
```

### Manual
    git clone https://github.com/Acalypha9/ecompi.git

- Install dependencies
  - `npm install`
  - `npx playwright install chromium`
- Ecompi production
  - `npm run build && npm start`
- Ecompi testing and development
  - `npm run dev`


## Playground
Host locally at `http://localhost:3000`

- These `parameter?`: means is optional

- `/health` : global health checking

### Blibli
The missing piece of blibli.com
- `/api/blibli` : blibli api
  - **get product**, takes parameters : `:slug`
  - **search**, takes parameters : `?q`, `?page`
  - **categories**
  - Example
    - http://localhost:3000/api/blibli/products/nintendo-switch-oled
    - http://localhost:3000/api/blibli/search?q=playstation&page=2
    - http://localhost:3000/api/blibli/categories

## Status response
`"success": true,` or `"success": false,`

    HTTP/1.1 200 OK
    HTTP/1.1 400 Validation Error
    HTTP/1.1 429 Rate limit exceeded
    HTTP/1.1 502 Scrape Failed / Blocked
    HTTP/1.1 503 Target site blocked the request

## Pronunciation
`en_US` • **/iːˈkɒmpaɪ/** — "ecom" stands for e-commerce and "pi" for API.

## Legal
This tool can be freely copied, modified, altered, distributed without any attribution whatsoever. However, if you feel like this tool deserves an attribution, mention it. Thank You.