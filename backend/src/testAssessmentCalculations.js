// Computes and stores backend-owned derived results for a
// tests.test_assessments row (e.g. WELLNESS Total), reading the raw values
// straight from tests.test_assessment_values and the formula from
// tests.test_version_derived_parameters/test_version_derived_parameter_inputs
// - never from a caller-supplied total. Callers pass a client already inside
// the same transaction that completes the assessment, so the derived result
// lands atomically with (or is rejected together with) the completion.
//
// Only calculation_method = 'average' is implemented in this phase. Any
// other method (sum/weighted_sum/conditional) is explicitly rejected, not
// silently skipped or replaced by a caller-supplied value - the criteria/
// full-evaluator engine is future work, not this function's job.
export async function computeAndStoreTestAssessmentDerivedResults(client, assessmentId) {
  const assessment = await client.query(
    `select id, test_version_id from tests.test_assessments where id = $1`,
    [assessmentId],
  );
  if (!assessment.rows[0]) throw new Error(`test_assessment ${assessmentId} not found`);
  const testVersionId = assessment.rows[0].test_version_id;

  const derivedParams = await client.query(
    `select id, parameter_key, calculation_method, result_type, missing_input_behavior, definition_version
     from tests.test_version_derived_parameters
     where test_version_id = $1
     order by parameter_key`,
    [testVersionId],
  );

  const results = [];
  for (const derived of derivedParams.rows) {
    if (derived.calculation_method !== "average") {
      throw new Error(
        `calculation_method "${derived.calculation_method}" is not supported in this phase (only "average" is implemented) - derived parameter ${derived.parameter_key}`,
      );
    }

    const inputs = await client.query(
      `select i.role, i.weight, i.input_source_kind, tp.id as parameter_id, tp.value_type
       from tests.test_version_derived_parameter_inputs i
       left join tests.test_parameters tp on tp.id = i.source_test_parameter_id
       where i.derived_parameter_id = $1
       order by i.role`,
      [derived.id],
    );
    if (!inputs.rows.length) throw new Error(`derived parameter ${derived.parameter_key} declares no inputs`);
    if (inputs.rows.some((row) => row.input_source_kind !== "native")) {
      throw new Error(`derived parameter ${derived.parameter_key} has a chained (test_derived) input - not supported by this phase's calculator`);
    }
    if (inputs.rows.some((row) => row.value_type && !["numeric", "integer", "ordinal"].includes(row.value_type))) {
      throw new Error(`derived parameter ${derived.parameter_key} has a non-numeric-compatible input parameter - "average" requires numeric-compatible inputs`);
    }

    const parameterIds = inputs.rows.map((row) => row.parameter_id);
    const values = await client.query(
      `select test_parameter_id, value_numeric from tests.test_assessment_values where assessment_id = $1 and test_parameter_id = any($2::uuid[])`,
      [assessmentId, parameterIds],
    );
    const valueByParam = new Map(values.rows.map((row) => [row.test_parameter_id, row.value_numeric === null ? null : Number(row.value_numeric)]));

    const numbers = parameterIds.map((id) => valueByParam.get(id));
    const hasMissing = numbers.some((n) => n === undefined || n === null);
    if (hasMissing) {
      if (derived.missing_input_behavior === "error") {
        throw new Error(`derived parameter ${derived.parameter_key} is missing one or more required input values for assessment ${assessmentId}`);
      }
      continue; // null_result: no result row written for this derived parameter
    }

    const total = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
    if (!Number.isFinite(total)) throw new Error(`computed result for derived parameter ${derived.parameter_key} is not a finite number`);

    const inserted = await client.query(
      `insert into tests.test_assessment_derived_results (assessment_id, test_version_id, test_version_derived_parameter_id, result_numeric, definition_version)
       values ($1,$2,$3,$4,$5)
       on conflict (assessment_id, test_version_derived_parameter_id)
       do update set result_numeric = excluded.result_numeric, definition_version = excluded.definition_version, computed_at = now()
       returning id, result_numeric`,
      [assessmentId, testVersionId, derived.id, total, derived.definition_version],
    );
    results.push({
      derivedParameterId: derived.id,
      parameterKey: derived.parameter_key,
      value: Number(inserted.rows[0].result_numeric),
    });
  }
  return results;
}
