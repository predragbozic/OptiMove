// Test-only installed-body mutations. The migration file and its manifest are never edited.
export const GALLERY_SQL_MUTATIONS = {
 'sql-shape-validation': {signature:'training_load.dashboard_chart_shape_valid(jsonb)', test:'SQL/JS shape allow-lists agree on every gallery form and invalid unions', from:'begin', to:'begin\n return true;'},
 'sql-axis-assignment': {signature:'training_load.dashboard_chart_shape_assert(uuid)', test:'combined axis assignment accepts labelled compatible axes and refuses a false axis claim', from:"r.axis is distinct from (case when axis_key='0' then 'primary' else 'secondary' end)",to:'false'},
 'sql-measurements': {signature:'training_load.dashboard_chart_shape_assert(uuid)', test:'DB write refuses aggregated heatmap and boxplot values', from:"s->>'kind' in ('heatmap','boxplot') and r.analytical_aggregation<>'none'", to:'false'},
 'sql-scope': {signature:'training_load.dashboard_chart_shape_assert(uuid)', test:'DB write refuses mixed data scope levels',from:'(select count(distinct v) from unnest(scopes) v)<>1',to:'false'},
 'sql-axis-units': {signature:'training_load.dashboard_chart_shape_assert(uuid)', test:'DB write refuses different units on the same combined axis',from:'or axes?axis_key and axes->>axis_key<>r.gallery_unit',to:''},
};
export async function installGallerySqlMutation(query,name){
 const mutation=GALLERY_SQL_MUTATIONS[name];if(!mutation)throw Error('Unknown test-only SQL mutation: '+name);
 const original=(await query('select pg_get_functiondef($1::regprocedure) body',[mutation.signature])).rows[0].body;
 if(!original.includes(mutation.from))throw Error('Installed mutation target missing: '+name);
 await query(original.replace(mutation.from,mutation.to.replaceAll('\\n','\n')));
 console.log('Installed test-only SQL mutation AFTER v94 apply/rollback/reapply: '+name);
}
