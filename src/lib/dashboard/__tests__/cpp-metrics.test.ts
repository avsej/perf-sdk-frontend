import type { Pool } from "pg"
import { HorizontalAxisDynamicUtil } from "@/src/lib/dashboard/axis"
import { createSystemMetricInput, createKVOperationInput } from "@/src/lib/dashboard/queries"
import {
  buildRunsWithBucketsQuery,
  buildRunsWithMetricsQuery,
  buildSafeJsonbFloatSql,
  buildSimplifiedGraphQuery,
  buildSimplifiedMetricQuery,
  extractChartAggregatedValue,
  NUMERIC_JSON_VALUE_PATTERN,
} from "@/src/lib/dashboard/graph-builders"
import {
  ResultType,
  type DatabaseCompare,
  type HorizontalAxisDynamic,
  type Input,
  type VerticalAxisBucketsColumn,
  type VerticalAxisMetric,
} from "@/src/lib/dashboard/dashboard-query-types"
import { DatabaseService } from "@/src/lib/database-service"
import { DataTransformers } from "@/src/shared/data/transformers"

const RUN_PRESENT = "11111111-1111-4111-8111-111111111111"
const RUN_ZERO = "22222222-2222-4222-8222-222222222222"
const RUN_MISSING = "33333333-3333-4333-8333-333333333333"
const RUN_EXTRA = "44444444-4444-4444-8444-444444444444"

describe("system metric queries and bar transformations", () => {
  test("buildSimplifiedMetricQuery filters missing JSON keys and aggregates run_ids", () => {
    const input = createSystemMetricInput("C++", "processCpu")
    expect(input.trimmingSeconds).toBe(0)
    const sql = buildSimplifiedMetricQuery(
      [RUN_PRESENT, RUN_ZERO],
      input.hAxis as unknown as HorizontalAxisDynamic,
      input.yAxes[0] as unknown as VerticalAxisMetric,
      input as unknown as Input
    )
    expect(sql).toContain("metrics.metrics::jsonb ? 'processCpu'")
    expect(sql).toContain(NUMERIC_JSON_VALUE_PATTERN)
    const metricKey = (input.yAxes[0] as unknown as VerticalAxisMetric).metric
    expect(sql).toContain("WHERE metric IS NOT NULL")
    expect(sql).toContain(
      buildSafeJsonbFloatSql(`metrics.metrics::jsonb->>'${metricKey}'`, `'${NUMERIC_JSON_VALUE_PATTERN}'`)
    )
    expect(sql).toContain("array_agg(DISTINCT run_id) AS run_ids")
    expect(sql).not.toContain("time_offset_secs >=")

    const unbucketisedMetricsSql = buildRunsWithMetricsQuery(input as unknown as Input, "processCpu")
    expect(unbucketisedMetricsSql).toContain(
      buildSafeJsonbFloatSql("metrics.metrics::jsonb->>'processCpu'", `'${NUMERIC_JSON_VALUE_PATTERN}'`)
    )
    expect(unbucketisedMetricsSql).toContain(
      `AND (metrics.metrics::jsonb->>'processCpu') ~ '${NUMERIC_JSON_VALUE_PATTERN}'`
    )

    const bucketisedMetricsSql = buildRunsWithMetricsQuery(
      { ...input, bucketiseSeconds: 10 } as unknown as Input,
      "processCpu"
    )
    expect(bucketisedMetricsSql).toContain(
      `avg(${buildSafeJsonbFloatSql("metrics.metrics::jsonb->>'processCpu'", `'${NUMERIC_JSON_VALUE_PATTERN}'`)})`
    )
    expect(bucketisedMetricsSql).toContain(
      `AND (metrics.metrics::jsonb->>'processCpu') ~ '${NUMERIC_JSON_VALUE_PATTERN}'`
    )

    const trimmedSql = buildSimplifiedMetricQuery(
      [RUN_PRESENT],
      input.hAxis as unknown as HorizontalAxisDynamic,
      input.yAxes[0] as unknown as VerticalAxisMetric,
      { ...input, trimmingSeconds: 20 } as unknown as Input
    )
    expect(trimmedSql).toContain("AND metrics.time_offset_secs >= 20")

    expect(() =>
      buildSimplifiedMetricQuery(
        [RUN_PRESENT],
        input.hAxis as unknown as HorizontalAxisDynamic,
        { type: "metric", metric: "bad'); DROP TABLE runs;--", yAxisID: "y" },
        input as unknown as Input
      )
    ).toThrow("Invalid metric name")

    expect(() =>
      buildSimplifiedGraphQuery(
        "params->'impl'->>'version'",
        [RUN_PRESENT],
        input as unknown as Input,
        { type: "buckets", column: "duration_average_us) FROM buckets;--", yAxisID: "y" } as VerticalAxisBucketsColumn
      )
    ).toThrow("Invalid bucket metric column")

    expect(() =>
      buildSimplifiedGraphQuery(
        "params->'impl'->>'version'); DROP TABLE runs;--",
        [RUN_PRESENT],
        input as unknown as Input,
        { type: "buckets", column: "duration_average_us", yAxisID: "y" } as VerticalAxisBucketsColumn
      )
    ).toThrow("Invalid groupBy expression")

    expect(
      HorizontalAxisDynamicUtil.databaseRepresentation1({
        type: "dynamic",
        databaseField: "privateEndpointsEnabled",
        resultType: ResultType.STRING,
      })
    ).toBe("params->>'privateEndpointsEnabled'")
    expect(
      HorizontalAxisDynamicUtil.databaseRepresentation2({
        type: "dynamic",
        databaseField: "privateEndpointsEnabled",
        resultType: ResultType.STRING,
      })
    ).toBe("{privateEndpointsEnabled}")
    expect(
      buildSimplifiedGraphQuery(
        "params->>'privateEndpointsEnabled'",
        [RUN_PRESENT],
        input as unknown as Input,
        { type: "buckets", column: "duration_average_us", yAxisID: "y" } as VerticalAxisBucketsColumn
      )
    ).toContain("params->>'privateEndpointsEnabled' as grouping")
    expect(
      HorizontalAxisDynamicUtil.databaseRepresentation1({
        type: "dynamic",
        databaseField: "vars.horizontalScaling",
        resultType: ResultType.INTEGER,
      })
    ).toBe("params->'vars'->>'horizontalScaling'")
    expect(() =>
      HorizontalAxisDynamicUtil.databaseRepresentation1({
        type: "dynamic",
        databaseField: "impl.version'); DROP TABLE runs;--",
        resultType: ResultType.VERSION_SEMVER,
      })
    ).toThrow("Invalid axis databaseField")
    expect(() =>
      HorizontalAxisDynamicUtil.databaseRepresentation2({
        type: "dynamic",
        databaseField: "impl.version}",
        resultType: ResultType.VERSION_SEMVER,
      })
    ).toThrow("Invalid axis databaseField")
  })

  test("DatabaseService.getRuns parameterizes comparison JSON and groupBy path", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const fakePool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows: [] }
      },
    } as unknown as Pool

    const db = new DatabaseService(fakePool)
    const untrustedCluster = "7.1.1'}) OR true --"
    const compare: DatabaseCompare = {
      cluster: { version: untrustedCluster },
      impl: { language: "C++" },
    }
    await db.getRuns(compare, "{impl,version}")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.sql).toContain("where (params) @> ($1::jsonb #- $2::text[])")
    expect(calls[0]?.sql).not.toContain(untrustedCluster)
    expect(calls[0]?.params).toEqual([
      JSON.stringify({ cluster: { version: untrustedCluster }, impl: { language: "C++" } }),
      "{impl,version}",
    ])
  })

  test("DatabaseService.getRunSystemMetricValues uses UUID array predicate and omits missing runs", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const fakePool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return {
          rows: [
            { run_id: RUN_PRESENT, value: "230.46" },
            { run_id: RUN_ZERO, value: 0 },
            { run_id: RUN_EXTRA, value: null },
          ],
        }
      },
    } as unknown as Pool

    const db = new DatabaseService(fakePool)
    const avgValues = await db.getRunSystemMetricValues(
      [RUN_PRESENT, RUN_ZERO, RUN_MISSING, "not-a-uuid"],
      "processCpuTotal",
      "Average"
    )
    const expectedSafeFloatParamSql = buildSafeJsonbFloatSql("metrics.metrics::jsonb->>$2", "$3")
    expect(calls[0]?.sql).toContain(`AVG(${expectedSafeFloatParamSql})`)
    expect(calls[0]?.sql).toContain("WHERE run_id = ANY($1::uuid[])")
    expect(calls[0]?.params).toEqual([
      [RUN_PRESENT, RUN_ZERO, RUN_MISSING],
      "processCpuTotal",
      NUMERIC_JSON_VALUE_PATTERN,
      0,
    ])
    expect(avgValues).toEqual({ [RUN_PRESENT]: 230.46, [RUN_ZERO]: 0 })
    expect(avgValues[RUN_MISSING]).toBeUndefined()

    await db.getRunSystemMetricValues([RUN_PRESENT], "memRssUsedMB", "Maximum", 20)
    expect(calls[1]?.sql).toContain(`MAX(${expectedSafeFloatParamSql})`)
    expect(calls[1]?.params?.[3]).toBe(20)

    const rejectedMetric = await db.getRunSystemMetricValues([RUN_PRESENT], "bad'name", "Average")
    expect(rejectedMetric).toEqual({})
    const rejectedIds = await db.getRunSystemMetricValues(["invalid-id"], "processCpuTotal", "Average")
    expect(rejectedIds).toEqual({})
    expect(calls).toHaveLength(2)

    const failingDb = new DatabaseService({
      query: async () => {
        throw new Error("db unavailable")
      },
    } as unknown as Pool)
    await expect(
      failingDb.getRunSystemMetricValues([RUN_PRESENT], "processCpuTotal", "Average")
    ).rejects.toThrow("db unavailable")

    const cohortCalls: Array<{ sql: string; params: unknown[] }> = []
    const cohortDb = new DatabaseService({
      query: async (sql: string, params: unknown[]) => {
        cohortCalls.push({ sql, params })
        return { rows: [{ value: "187.5" }] }
      },
    } as unknown as Pool)
    const sysInput = createSystemMetricInput("C++", "processCpu") as unknown as Input
    await expect(cohortDb.getCohortAggregatedValue([RUN_PRESENT, RUN_ZERO], sysInput)).resolves.toBe(187.5)
    expect(cohortCalls[0]?.sql).toContain(`AVG(${expectedSafeFloatParamSql})`)
    expect(cohortCalls[0]?.params).toEqual([
      [RUN_PRESENT, RUN_ZERO],
      "processCpu",
      NUMERIC_JSON_VALUE_PATTERN,
      0,
    ])

    const kvInput = createKVOperationInput("C++", "get", false, true, "duration_p95_us") as unknown as Input
    await expect(cohortDb.getCohortAggregatedValue([RUN_PRESENT], kvInput)).resolves.toBe(187.5)
    expect(cohortCalls[1]?.sql).toContain("AVG(buckets.duration_p95_us)")
    expect(cohortCalls[1]?.params).toEqual([[RUN_PRESENT], 20])
    await expect(cohortDb.getCohortAggregatedValue([], kvInput)).resolves.toBeNull()
    await expect(cohortDb.getCohortAggregatedValue(["bad-id"], kvInput)).resolves.toBeNull()
    await expect(failingDb.getCohortAggregatedValue([RUN_PRESENT], sysInput)).rejects.toThrow("db unavailable")

    const bucketCalls: Array<{ sql: string; params: unknown[] }> = []
    const bucketDb = new DatabaseService({
      query: async (sql: string, params: unknown[]) => {
        bucketCalls.push({ sql, params })
        return {
          rows: [
            { run_id: RUN_PRESENT, value: "4200.5" },
            { run_id: RUN_ZERO, value: 0 },
          ],
        }
      },
    } as unknown as Pool)
    const bucketValues = await bucketDb.getRunBucketMetricValues(
      [RUN_PRESENT, RUN_ZERO, "invalid-id"],
      "operations_total",
      "Average",
      20
    )
    expect(bucketCalls[0]?.sql).toContain("AVG(buckets.operations_total)")
    expect(bucketCalls[0]?.params).toEqual([[RUN_PRESENT, RUN_ZERO], 20])
    expect(bucketValues).toEqual({ [RUN_PRESENT]: 4200.5, [RUN_ZERO]: 0 })
    await expect(
      bucketDb.getRunBucketMetricValues([RUN_PRESENT], "bad_col", "Average", 20)
    ).rejects.toThrow("Invalid bucket metric column")
    await expect(
      failingDb.getRunBucketMetricValues([RUN_PRESENT], "duration_p95_us", "Average", 20)
    ).rejects.toThrow("db unavailable")

    const neverCalledDb = new DatabaseService({
      query: async () => {
        throw new Error("pool should not be queried for empty cohorts")
      },
    } as unknown as Pool)
    await expect(
      neverCalledDb.getSimplifiedGraph(
        "params->'impl'->>'version'",
        [],
        kvInput,
        kvInput.yAxes[0] as VerticalAxisBucketsColumn
      )
    ).resolves.toEqual([])
    await expect(
      neverCalledDb.getRunsWithBuckets([], kvInput, "duration_average_us", false, false)
    ).resolves.toEqual([])
    await expect(
      neverCalledDb.getRunsWithBuckets([], kvInput, "", false, true)
    ).resolves.toEqual([])
    await expect(
      neverCalledDb.getRunsWithMetrics([], sysInput, "processCpu")
    ).resolves.toEqual([])
    await expect(
      neverCalledDb.getRunsWithBuckets(["not-a-uuid"], kvInput, "duration_average_us", false, false)
    ).rejects.toThrow("No valid UUID run IDs provided")
    await expect(
      neverCalledDb.getRunsWithMetrics(["not-a-uuid"], sysInput, "processCpu")
    ).rejects.toThrow("No valid UUID run IDs provided")

    const unbucketisedBucketsSql = buildRunsWithBucketsQuery(
      [RUN_PRESENT],
      kvInput,
      "duration_average_us",
      false,
      false
    )
    expect(unbucketisedBucketsSql).toContain("buckets.run_id = ANY($1::uuid[])")
    expect(unbucketisedBucketsSql).toContain("buckets.time_offset_secs >= $2::bigint")

    const bucketisedBucketsSql = buildRunsWithBucketsQuery(
      [RUN_PRESENT],
      { ...kvInput, bucketiseSeconds: 10 } as unknown as Input,
      "",
      false,
      true
    )
    expect(bucketisedBucketsSql).toContain("buckets.run_id = ANY($1::uuid[])")
    expect(bucketisedBucketsSql).toContain("buckets.time_offset_secs >= $2::bigint")

    const fullBucketCalls: Array<{ sql: string; params: unknown[] }> = []
    const fullBucketDb = new DatabaseService({
      query: async (sql: string, params: unknown[]) => {
        fullBucketCalls.push({ sql, params })
        return {
          rows: [
            {
              run_id: RUN_PRESENT,
              datetime: "2026-11-26T18:00:20.000Z",
              time_offset_secs: "20",
              value: 145,
              errors: null,
              metrics: null,
            },
          ],
        }
      },
    } as unknown as Pool)
    const fullPairs = await fullBucketDb.getRunsWithBuckets(
      [RUN_PRESENT, "not-a-uuid"],
      kvInput,
      "duration_average_us",
      false,
      false
    )
    expect(fullBucketCalls[0]?.params).toEqual([[RUN_PRESENT], 20])
    expect(fullPairs).toHaveLength(1)
  })

  test("extractChartAggregatedValue requires exact run-ID cohort match when targetRunIds are supplied", () => {
    const chartData = {
      data: {
        labels: ["main", "main@34173e4"],
        datasets: [{ data: [180.25, 230.46] }],
        runIds: [
          [RUN_PRESENT, RUN_EXTRA],
          [RUN_ZERO, RUN_MISSING, RUN_ZERO],
        ],
      },
    }

    expect(extractChartAggregatedValue(chartData, "main")).toBe(180.25)
    expect(extractChartAggregatedValue(chartData, "main", [RUN_MISSING, RUN_ZERO])).toBe(230.46)
    expect(
      extractChartAggregatedValue(chartData, "main", [
        RUN_MISSING.toUpperCase(),
        RUN_ZERO.toUpperCase(),
      ])
    ).toBe(230.46)
    expect(extractChartAggregatedValue(chartData, "main", [RUN_PRESENT])).toBeNull()
    expect(extractChartAggregatedValue(chartData, "main", [RUN_ZERO, RUN_EXTRA])).toBeNull()
  })

  test("DataTransformers.toBarChartFromDashboard omits null and empty values while keeping numeric 0", () => {
    const transformed = DataTransformers.toBarChartFromDashboard(
      {
        results: [
          { grouping: "1.0.0", value: null, runIds: ["r1"] },
          { grouping: "1.1.0", value: undefined, runIds: ["r2"] },
          { grouping: "1.1.1", value: "", runIds: ["r2b"] },
          { grouping: "1.2.0", value: 0, runIds: ["r3"] },
          { grouping: "main@34173e4", value: 230.46, runIds: ["r4"] },
        ],
      },
      "C++"
    )

    expect(transformed.map((d) => ({ name: d.name, value: d.value }))).toEqual([
      { name: "1.2.0", value: 0 },
      { name: "main@34173e4", value: 230.46 },
    ])

    const fromDatasets = DataTransformers.toBarChartFromDashboard(
      {
        data: {
          labels: ["1.0.0", "1.2.0", "main@34173e4"],
          datasets: [{ data: [null, 0, 14.75] }],
          runIds: [["r1"], ["r2"], ["r3"]],
        },
      },
      "C++"
    )

    expect(fromDatasets.map((d) => ({ name: d.name, value: d.value }))).toEqual([
      { name: "1.2.0", value: 0 },
      { name: "main@34173e4", value: 14.75 },
    ])
  })
})
