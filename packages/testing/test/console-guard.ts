import { afterEach, beforeEach } from "vitest"
import { startConsoleGuard, stopConsoleGuard } from "../src/console.js"

beforeEach(startConsoleGuard)
afterEach(stopConsoleGuard)
