import { afterEach, beforeEach } from "vitest"
import { startConsoleGuard, stopConsoleGuard } from "@civfix/testing/console"

beforeEach(startConsoleGuard)
afterEach(stopConsoleGuard)
