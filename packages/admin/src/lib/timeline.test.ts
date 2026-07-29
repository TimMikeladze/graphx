import { describe, expect, it } from "bun:test"
import { nearestTick, presetTime, stepTick, timeToX, xToTime } from "./timeline"

const TICKS = [100, 200, 500, 900]

describe("nearestTick", () => {
  it("returns the closest tick on either side", () => {
    expect(nearestTick(TICKS, 180)).toBe(200)
    expect(nearestTick(TICKS, 120)).toBe(100)
    expect(nearestTick(TICKS, 500)).toBe(500)
  })
  it("clamps past both ends", () => {
    expect(nearestTick(TICKS, 0)).toBe(100)
    expect(nearestTick(TICKS, 10_000)).toBe(900)
  })
  it("breaks an exact tie toward the earlier tick", () => {
    expect(nearestTick([0, 100], 50)).toBe(0)
  })
  it("has nothing to return for an empty tick list", () => {
    expect(nearestTick([], 5)).toBeUndefined()
  })
})

describe("stepTick", () => {
  it("moves to the adjacent tick", () => {
    expect(stepTick(TICKS, 200, 1)).toBe(500)
    expect(stepTick(TICKS, 200, -1)).toBe(100)
  })
  it("steps from a time that is not itself a tick", () => {
    expect(stepTick(TICKS, 250, 1)).toBe(500)
    expect(stepTick(TICKS, 250, -1)).toBe(200)
  })
  it("returns undefined at the ends so the caller can stop", () => {
    expect(stepTick(TICKS, 900, 1)).toBeUndefined()
    expect(stepTick(TICKS, 100, -1)).toBeUndefined()
    expect(stepTick([], 5, 1)).toBeUndefined()
  })
})

describe("presetTime", () => {
  it("subtracts the preset window from now", () => {
    const now = 1_000_000_000_000
    expect(presetTime("1h", now)).toBe(now - 3_600_000)
    expect(presetTime("1d", now)).toBe(now - 86_400_000)
    expect(presetTime("7d", now)).toBe(now - 604_800_000)
  })
})

describe("time and pixel conversion", () => {
  it("round-trips a time through a pixel offset", () => {
    expect(timeToX(500, 0, 1000, 200)).toBe(100)
    expect(xToTime(100, 0, 1000, 200)).toBe(500)
  })
  it("clamps outside the window", () => {
    expect(timeToX(-50, 0, 1000, 200)).toBe(0)
    expect(timeToX(5000, 0, 1000, 200)).toBe(200)
    expect(xToTime(-10, 0, 1000, 200)).toBe(0)
    expect(xToTime(9999, 0, 1000, 200)).toBe(1000)
  })
  it("puts a zero-width window at the start rather than dividing by zero", () => {
    expect(timeToX(7, 7, 7, 200)).toBe(0)
    expect(xToTime(150, 7, 7, 200)).toBe(7)
  })
})
