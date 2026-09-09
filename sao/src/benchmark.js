/* This file is part of Tryton.  The COPYRIGHT file at the top level of
   this repository contains the full copyright notices and license terms. */

/* Sao benchmark plugin -- measurement core and detached screen driver.

     Stats   pure statistical helpers, no DOM and no RPC
     Csv     serialization (pure) and delivery (modal) of the three files
     Probe   RPC instrumentation, install() / uninstall()
     Driver  replay of one plan entry (latency | server | act_window) on an
             off-screen Sao.Screen, never through Sao.Tab
     Runner  run_campaign(config, hooks): activation guard, plan, setup /
             teardown, warmup, loop, isolated failures, cooperative abort
     Dialog  Sao.Dialog: configuration, progress, results, CSV export

   Loaded through the `jsfiles` list of Gruntfile.js only: index.html must NOT
   get an extra <script> tag for it (the IIFE would run twice, so
   Sao.Plugins.push() would run twice and the menu entry would be duplicated on
   every model, and src/ is never copied into the Docker image). */

(function() {
    'use strict';

    Sao.Benchmark = {};

    var now = function() {
        if (window.performance && window.performance.now) {
            return window.performance.now();
        }
        return Date.now();
    };

    // ================================================================
    // Stats -- pure helpers.  No DOM, no RPC, no state.
    // ================================================================

    var Stats = {};
    Sao.Benchmark.Stats = Stats;

    // Publication thresholds of the percentiles.  A p99 computed on 100
    // samples is the 99th order statistic out of 100: one observation away
    // from the maximum, with no statistical content.  Below its threshold a
    // percentile is reported as an EMPTY cell -- never 0, never null, so that
    // a spreadsheet cannot average it in by accident.
    Stats.PERCENTILES = [
        {label: 'p50', p: 0.50, min_n: 1},
        {label: 'p75', p: 0.75, min_n: 1},
        {label: 'p90', p: 0.90, min_n: 1},
        {label: 'p95', p: 0.95, min_n: 200},
        {label: 'p99', p: 0.99, min_n: 1000}
    ];

    // Above this size, 0.5^n underflows and the exact binomial recursion used
    // by the median confidence interval loses its footing; a normal
    // approximation takes over.
    var BINOM_EXACT_MAX = 1000;

    // Two-sided 95%: 1.959963985 standard deviations.
    var Z_975 = 1.959963985;

    var sorted_asc = function(values) {
        var out = [];
        var i;
        if (!values) {
            return out;
        }
        for (i = 0; i < values.length; i++) {
            var value = Number(values[i]);
            // A single NaN or Infinity slipped into a series would silently
            // poison every statistic computed from it.
            if (isFinite(value)) {
                out.push(value);
            }
        }
        out.sort(function(a, b) {
            return a - b;
        });
        return out;
    };

    var s_min = function(s) {
        return s.length ? s[0] : null;
    };

    var s_max = function(s) {
        return s.length ? s[s.length - 1] : null;
    };

    var s_mean = function(s) {
        if (!s.length) {
            return null;
        }
        var total = 0;
        for (var i = 0; i < s.length; i++) {
            total += s[i];
        }
        return total / s.length;
    };

    var s_median = function(s) {
        if (!s.length) {
            return null;
        }
        var middle = Math.floor(s.length / 2);
        if (s.length % 2) {
            return s[middle];
        }
        return (s[middle - 1] + s[middle]) / 2;
    };

    var s_stddev = function(s) {
        // Sample standard deviation (n - 1).  Undefined on a single
        // observation: null, not 0.
        if (s.length < 2) {
            return null;
        }
        var mean = s_mean(s);
        var total = 0;
        for (var i = 0; i < s.length; i++) {
            total += (s[i] - mean) * (s[i] - mean);
        }
        return Math.sqrt(total / (s.length - 1));
    };

    var s_mad = function(s) {
        // Median absolute deviation: a dispersion measure that a single
        // outlier cannot move, unlike the standard deviation.
        var median = s_median(s);
        if (median === null) {
            return null;
        }
        var deviations = [];
        for (var i = 0; i < s.length; i++) {
            deviations.push(Math.abs(s[i] - median));
        }
        return s_median(sorted_asc(deviations));
    };

    var s_percentile = function(s, p) {
        // Nearest rank: index = ceil(p * N) over the sorted sample.  This is
        // the SLO semantics -- the reported value is an observation that was
        // actually measured, never an interpolation between two of them.
        if (!s.length) {
            return null;
        }
        var index = Math.ceil(p * s.length);
        if (index < 1) {
            index = 1;
        }
        if (index > s.length) {
            index = s.length;
        }
        return s[index - 1];
    };

    var s_percentile_r7 = function(s, p) {
        // R-7, linear interpolation: the numpy / Excel convention.  Emitted
        // next to the nearest rank so the figures can be compared with what
        // any other tool would produce on the same series.
        if (!s.length) {
            return null;
        }
        if (s.length == 1) {
            return s[0];
        }
        var h = (s.length - 1) * p;
        if (h < 0) {
            h = 0;
        }
        if (h > s.length - 1) {
            h = s.length - 1;
        }
        var low = Math.floor(h);
        var high = Math.min(low + 1, s.length - 1);
        return s[low] + (h - low) * (s[high] - s[low]);
    };

    var s_median_ci95 = function(s) {
        // 95% confidence interval on the median by order statistics
        // (binomial), so no normality is assumed: latency distributions are
        // skewed and often bimodal, a normal-based interval would be wrong.
        var n = s.length;
        if (n < 6) {
            // Below n = 6 no distribution-free 95% interval exists at all:
            // 2 * 0.5^5 = 0.0625 > 0.05.
            return null;
        }
        var rank_low = 0;
        var coverage = null;
        var exact = n <= BINOM_EXACT_MAX;
        var i;
        if (exact) {
            // term(i) = C(n, i) * 0.5^n, by ratio recursion from term(0).
            var term = Math.pow(0.5, n);
            var cdf = 0;
            for (i = 0; i < n; i++) {
                if (i > 0) {
                    term = term * (n - i + 1) / i;
                }
                cdf += term;
                if (cdf > 0.025) {
                    break;
                }
                rank_low = i + 1;
                coverage = 1 - 2 * cdf;
            }
        } else {
            rank_low = Math.floor(n / 2 - Z_975 * Math.sqrt(n) / 2);
            coverage = 0.95;
        }
        if (rank_low < 1) {
            return null;
        }
        var rank_high = n - rank_low + 1;
        if (rank_high <= rank_low) {
            return null;
        }
        return {
            low: s[rank_low - 1],
            high: s[rank_high - 1],
            coverage: coverage,
            rank_low: rank_low,
            rank_high: rank_high,
            exact: exact
        };
    };

    Stats.sorted = function(values) {
        return sorted_asc(values);
    };

    Stats.count = function(values) {
        return sorted_asc(values).length;
    };

    // True extremes, never truncated.  The server side aggregates with
    // do_bench (bench.py:29-38) which sorts, drops the first and last value,
    // then averages over that already truncated list minus two more: its
    // `minimum` and `maximum` are the 3rd smallest and 3rd largest of the
    // original sample, and even its `slowest` is only the 2nd largest.  The
    // latency tail is exactly the signal a WAF shows up in, so that
    // aggregation is deliberately NOT reproduced here.
    Stats.min = function(values) {
        return s_min(sorted_asc(values));
    };

    Stats.max = function(values) {
        return s_max(sorted_asc(values));
    };

    Stats.mean = function(values) {
        return s_mean(sorted_asc(values));
    };

    Stats.stddev = function(values) {
        return s_stddev(sorted_asc(values));
    };

    Stats.median = function(values) {
        return s_median(sorted_asc(values));
    };

    Stats.mad = function(values) {
        return s_mad(sorted_asc(values));
    };

    Stats.percentile = function(values, p) {
        return s_percentile(sorted_asc(values), p);
    };

    Stats.percentile_r7 = function(values, p) {
        return s_percentile_r7(sorted_asc(values), p);
    };

    Stats.median_ci95 = function(values) {
        return s_median_ci95(sorted_asc(values));
    };

    Stats.publishable = function(p, n) {
        for (var i = 0; i < Stats.PERCENTILES.length; i++) {
            if (Stats.PERCENTILES[i].p == p) {
                return n >= Stats.PERCENTILES[i].min_n;
            }
        }
        return n > 0;
    };

    Stats.summary = function(values) {
        // Sorts once and derives everything from that.  Percentiles below
        // their publication threshold come back as '' (empty cell); anything
        // not computable at all comes back as null and the CSV layer renders
        // it empty too.
        var s = sorted_asc(values);
        var n = s.length;
        var ci = s_median_ci95(s);
        var summary = {
            n: n,
            min: s_min(s),
            max: s_max(s),
            mean: s_mean(s),
            stddev: s_stddev(s),
            median: s_median(s),
            mad: s_mad(s),
            median_ci95_low: ci ? ci.low : null,
            median_ci95_high: ci ? ci.high : null,
            median_ci95_coverage: ci ? ci.coverage : null,
            median_ci95_exact: ci ? ci.exact : null
        };
        for (var i = 0; i < Stats.PERCENTILES.length; i++) {
            var spec = Stats.PERCENTILES[i];
            var publish = n >= spec.min_n;
            summary[spec.label] = publish ? s_percentile(s, spec.p) : '';
            summary[spec.label + '_r7'] = (
                publish ? s_percentile_r7(s, spec.p) : '');
        }
        return summary;
    };

    // ================================================================
    // Csv -- serialization (pure) and delivery (modal), kept apart.
    // ================================================================

    var Csv = {};
    Sao.Benchmark.Csv = Csv;

    // Bootstrap fade duration plus a margin, used to space out the download
    // dialogs so a modal is never shown while the previous one still fades.
    var MODAL_TRANSITION_MS = 400;

    var is_windows = function() {
        return Boolean(navigator.platform &&
            (navigator.platform.slice(0, 3) == 'Win'));
    };

    Csv.delimiter = function() {
        // Same house rule as the tree export (tab.js:1806-1812).
        return is_windows() ? ';' : ',';
    };

    Csv.want_bom = function() {
        return is_windows();
    };

    Csv.cell = function(value) {
        if ((value === null) || (value === undefined)) {
            return '';
        }
        if (value === true) {
            return 'true';
        }
        if (value === false) {
            return 'false';
        }
        return String(value);
    };

    Csv.num = function(value, digits) {
        if ((value === null) || (value === undefined) || (value === '')) {
            return '';
        }
        var number = Number(value);
        if (!isFinite(number)) {
            return '';
        }
        // toFixed / String always emit a '.' decimal separator whatever the
        // interface language.  Sao.Window.Export.format_row (window.js:2611)
        // goes through toLocaleString and yields a decimal comma in French,
        // which makes the file unusable as numbers -- never route through it.
        if (digits === undefined) {
            return String(number);
        }
        return number.toFixed(digits);
    };

    Csv.ms = function(value) {
        // All durations are milliseconds with three decimals.
        return Csv.num(value, 3);
    };

    Csv.serialize = function(coldefs, records, options) {
        // Pure: coldefs + records in, CSV string out.  No DOM, no download.
        options = options || {};
        // Whole-file context, handed to every getter as a second argument.
        // A column that needs to see the OTHER rows -- joinability is one:
        // it is a property of a method across the campaign, not of a row --
        // reads it from here instead of the file layer annotating the
        // samples in place.  Getters that do not need it simply ignore it.
        var context = options.context;
        var delimiter = options.delimiter;
        if (delimiter === undefined) {
            delimiter = Csv.delimiter();
        }
        var bom = options.bom;
        if (bom === undefined) {
            bom = Csv.want_bom();
        }
        var data = [coldefs.map(function(coldef) {
            return coldef.name;
        })];
        (records || []).forEach(function(record) {
            data.push(coldefs.map(function(coldef) {
                return coldef.get(record, context);
            }));
        });
        // Sao passes the header as the first data row and never uses the
        // `fields` key (tab.js:1810).
        var csv = Papa.unparse({'data': data}, {
            quoteChar: '"',
            delimiter: delimiter
        });
        if (bom) {
            csv = Sao.BOM_UTF8 + csv;
        }
        return csv;
    };

    var text_column = function(name, key) {
        return {
            name: name,
            get: function(record) {
                return Csv.cell(record[key]);
            }
        };
    };

    var ms_column = function(name, key) {
        return {
            name: name,
            get: function(record) {
                return Csv.ms(record[key]);
            }
        };
    };

    var rt_column = function(name, key) {
        return {
            name: name,
            get: function(record) {
                return record.rt ? Csv.ms(record.rt[key]) : '';
            }
        };
    };

    var rt_text_column = function(name, key) {
        return {
            name: name,
            get: function(record) {
                return record.rt ? Csv.cell(record.rt[key]) : '';
            }
        };
    };

    // One row per campaign.  Both the browser window AND the detached
    // container dimensions are recorded, under distinct columns: the window
    // is what enters the fields_view_get cache key (screen.js:930-936), the
    // container is what decides how many tree rows get built.  Merging them
    // would make two campaigns run at different window sizes look comparable.
    Csv.META_COLUMNS = [
        text_column('run_id', 'run_id'),
        text_column('arm', 'arm'),
        text_column('started_at', 'started_at'),
        text_column('finished_at', 'finished_at'),
        text_column('iterations', 'iterations'),
        text_column('warmup_k', 'warmup_k'),
        text_column('plan_entries', 'plan_entries'),
        text_column('server_version', 'server_version'),
        text_column('sao_version', 'sao_version'),
        text_column('database', 'database'),
        text_column('user_id', 'user_id'),
        text_column('login', 'login'),
        text_column('user_agent', 'user_agent'),
        text_column('platform', 'platform'),
        text_column('language', 'language'),
        text_column('cross_origin_isolated', 'cross_origin_isolated'),
        text_column('visibility_state', 'visibility_state'),
        text_column('window_width', 'window_width'),
        text_column('window_height', 'window_height'),
        text_column('viewport_width', 'viewport_width'),
        text_column('viewport_height', 'viewport_height'),
        text_column('container_width', 'container_width'),
        text_column('container_height', 'container_height'),
        text_column('screen_width', 'screen_width'),
        text_column('screen_height', 'screen_height'),
        text_column('device_pixel_ratio', 'device_pixel_ratio'),
        text_column('config_limit', 'config_limit'),
        text_column('config_display_size', 'config_display_size'),
        text_column('next_hop_protocol', 'next_hop_protocol'),
        text_column('bus_stopped', 'bus_stopped'),
        text_column('sample_count', 'sample_count'),
        text_column('rpc_ajax_send_count', 'rpc_ajax_send_count'),
        text_column('resource_entry_count', 'resource_entry_count'),
        text_column('orphan_resource_entries', 'orphan_resource_entries'),
        text_column(
            'ambiguous_resource_entries', 'ambiguous_resource_entries'),
        text_column('resource_timing_desync', 'resource_timing_desync'),
        text_column('resource_buffer_full', 'resource_buffer_full'),
        text_column('ambiguous_json_parse', 'ambiguous_json_parse'),
        text_column(
            'performance_observer_available', 'performance_observer_available'),
        text_column('notes', 'notes')
    ];

    var emitted_rpc_row = function(sample) {
        // A row the server actually saw, and therefore the only kind that
        // HAS a log line to be joined to.  A call served by the client cache
        // deliberately consumes no seq (see call_only_sample), so it has
        // none, and neither does a render phase row.
        return Boolean(sample) && (sample.kind == 'rpc') &&
            (sample.seq !== null) && (sample.seq !== undefined) &&
            (sample.seq !== '');
    };

    // Which methods overlapped THEMSELVES during the campaign window.
    //
    // The positional join with the server log is by (rpc_method, seq): seq
    // counts per method, and the log line names the method too, so
    // concurrency between DIFFERENT methods is harmless -- rank N still faces
    // rank N on both sides.  Only a method running concurrently with itself
    // breaks it, because the server is then free to finish the two in the
    // other order and the ranks cross.
    //
    // Derived at EXPORT time from the timestamps already carried by the rows.
    // Nothing is added to the measurement path -- this is exactly how the
    // overlap was found in the first place -- so no figure moves because this
    // column exists.
    Csv.self_overlapping_methods = function(samples) {
        var by_method = {};
        (samples || []).forEach(function(sample) {
            if (!emitted_rpc_row(sample)) {
                return;
            }
            var method = sample.rpc_method || '';
            if (!by_method[method]) {
                by_method[method] = [];
            }
            by_method[method].push(sample);
        });
        var overlapping = {};
        Object.keys(by_method).forEach(function(method) {
            var spans = [];
            var unbounded = false;
            by_method[method].forEach(function(sample) {
                if ((typeof sample.t_start_ms != 'number') ||
                        (typeof sample.t_end_ms != 'number')) {
                    // A window that never closed cannot be shown NOT to
                    // overlap.  The method is reported unjoinable rather than
                    // optimistically joined: the whole point of the column is
                    // to stop an operator joining rows that must not be.
                    unbounded = true;
                    return;
                }
                spans.push([sample.t_start_ms, sample.t_end_ms]);
            });
            if (unbounded) {
                overlapping[method] = true;
                return;
            }
            spans.sort(function(left, right) {
                return left[0] - right[0];
            });
            // Sorted by start, an overlap exists as soon as one span starts
            // before the LARGEST end seen so far.  Comparing with the
            // previous span alone would miss a short call nested inside a
            // long one.
            var max_end = null;
            for (var i = 0; i < spans.length; i++) {
                if ((max_end !== null) && (spans[i][0] < max_end)) {
                    overlapping[method] = true;
                    return;
                }
                if ((max_end === null) || (spans[i][1] > max_end)) {
                    max_end = spans[i][1];
                }
            }
        });
        return overlapping;
    };

    // Peak number of RPC calls in flight at once, per scenario and regime.
    // This is the figure that makes the rest of the file readable: a list
    // scenario sits at 1 and a form scenario climbs to twenty-odd, and THAT
    // is why their retained sample rates differ.  Without it the difference
    // reads as an instrument defect instead of a property of the screen.
    //
    // Per regime and not per scenario alone, for the same reason the
    // percentiles are: cold and warm are two different populations, and a
    // warm run whose getters are mostly cache hits puts far fewer calls on
    // the wire.  Warmup iterations are INCLUDED -- how concurrent a screen is
    // does not depend on whether the iteration counted.
    Csv.peak_in_flight = function(samples) {
        var events = {};
        (samples || []).forEach(function(sample) {
            if (!emitted_rpc_row(sample) ||
                    (typeof sample.t_start_ms != 'number') ||
                    (typeof sample.t_end_ms != 'number')) {
                return;
            }
            var key = Csv.scenario_key(sample.scenario, sample.regime);
            if (!events[key]) {
                events[key] = [];
            }
            events[key].push([sample.t_start_ms, 1], [sample.t_end_ms, -1]);
        });
        var peaks = {};
        Object.keys(events).forEach(function(key) {
            var list = events[key];
            list.sort(function(left, right) {
                // On a tie the END comes first: a call that stops at the very
                // instant the next one starts was never in flight beside it.
                return (left[0] - right[0]) || (left[1] - right[1]);
            });
            var current = 0;
            var peak = 0;
            list.forEach(function(event) {
                current += event[1];
                if (current > peak) {
                    peak = current;
                }
            });
            peaks[key] = peak;
        });
        return peaks;
    };

    Csv.scenario_key = function(scenario, regime) {
        return (scenario || '') + '\u0000' + (regime || '');
    };

    // One row per RPC attempt and one row per render phase.  The four
    // correlation columns are always emitted: rpc_method (raw), the
    // srv_model / srv_method split (so the textual join with the server log
    // line does not depend on a split improvised in a spreadsheet), seq (the
    // server join key) and rpc_id (the client side truth).
    Csv.RAW_COLUMNS = [
        text_column('run_id', 'run_id'),
        text_column('arm', 'arm'),
        text_column('regime', 'regime'),
        text_column('scenario', 'scenario'),
        text_column('iteration', 'iteration'),
        text_column('warmup', 'warmup'),
        text_column('kind', 'kind'),
        text_column('phase', 'phase'),
        text_column('rpc_method', 'rpc_method'),
        text_column('srv_model', 'srv_model'),
        text_column('srv_method', 'srv_method'),
        text_column('seq', 'seq'),
        text_column('rpc_id', 'rpc_id'),
        // Whether this row may be joined to the server log by rank.  False
        // means its method overlapped ITSELF somewhere in the campaign, so
        // rank N on one side is not rank N on the other and the join is
        // invalid for that method -- even though the counts match, which is
        // exactly the trap this column exists to close.  Empty on a row the
        // server never saw (cache hit, render phase): there is nothing to
        // join, and 'false' would read as a warning where there is none.
        {
            name: 'srv_joinable',
            get: function(record, context) {
                if (!emitted_rpc_row(record)) {
                    return '';
                }
                var overlapping = (context && context.self_overlapping) || {};
                return Csv.cell(!overlapping[record.rpc_method || '']);
            }
        },
        text_column('attempt', 'attempt'),
        text_column('served_from_cache', 'served_from_cache'),
        text_column('sync', 'sync'),
        ms_column('t_start_ms', 't_start_ms'),
        ms_column('t_end_ms', 't_end_ms'),
        ms_column('duration_ms', 'duration_ms'),
        ms_column('duration_app_ms', 'duration_app_ms'),
        ms_column('duration_transport_ms', 'duration_transport_ms'),
        ms_column('json_parse_ms', 'json_parse_ms'),
        text_column('http_status', 'http_status'),
        rt_column('rt_dns_ms', 'dns_ms'),
        rt_column('rt_connect_ms', 'connect_ms'),
        rt_column('rt_tls_ms', 'tls_ms'),
        rt_column('rt_request_ms', 'request_ms'),
        rt_column('rt_ttfb_ms', 'ttfb_ms'),
        rt_column('rt_response_ms', 'response_ms'),
        rt_column('rt_duration_ms', 'duration_ms'),
        rt_text_column('transfer_size', 'transfer_size'),
        rt_text_column('encoded_body_size', 'encoded_body_size'),
        rt_text_column('decoded_body_size', 'decoded_body_size'),
        // Risk 5: a WAF that downgrades h2 to http/1.1 shows up as a huge
        // overhead that has nothing to do with inspection.  Checked before any
        // conclusion is drawn.
        rt_text_column('next_hop_protocol', 'next_hop_protocol'),
        {
            name: 'valid',
            get: function(record) {
                return Csv.cell(Probe.is_valid(record));
            }
        },
        {
            name: 'invalid_causes',
            get: function(record) {
                return (record.causes || []).join(';');
            }
        }
    ];

    // One row per scenario x phase x regime.  For an RPC row the `phase`
    // column carries 'rpc:<method>'; `kind` disambiguates.
    Csv.AGG_COLUMNS = [
        text_column('run_id', 'run_id'),
        text_column('arm', 'arm'),
        text_column('scenario', 'scenario'),
        text_column('kind', 'kind'),
        text_column('phase', 'phase'),
        text_column('regime', 'regime'),
        text_column('n', 'n'),
        text_column('n_invalid', 'n_invalid'),
        text_column('n_cached', 'n_cached'),
        // WHY the dropped samples were dropped, "cause=count" separated by
        // semicolons.  n_invalid alone says a figure is missing; this says
        // whether it went missing for a reason that concerns the reader.
        // Only INVALIDATING causes are tallied.
        text_column('invalid_causes', 'invalid_causes'),
        // Peak RPC calls in flight for this scenario and regime.  Sits next
        // to n_invalid on purpose: a 1 here means a strictly serialized
        // screen whose samples are all correlatable, a 24 means a screen that
        // fires a burst, and the retained rate of the row is only readable
        // against it.
        text_column('peak_in_flight', 'peak_in_flight'),
        ms_column('min_ms', 'min'),
        ms_column('max_ms', 'max'),
        ms_column('mean_ms', 'mean'),
        ms_column('stddev_ms', 'stddev'),
        ms_column('median_ms', 'median'),
        ms_column('mad_ms', 'mad'),
        ms_column('p50_ms', 'p50'),
        ms_column('p75_ms', 'p75'),
        ms_column('p90_ms', 'p90'),
        ms_column('p95_ms', 'p95'),
        ms_column('p99_ms', 'p99'),
        ms_column('p50_r7_ms', 'p50_r7'),
        ms_column('p75_r7_ms', 'p75_r7'),
        ms_column('p90_r7_ms', 'p90_r7'),
        ms_column('p95_r7_ms', 'p95_r7'),
        ms_column('p99_r7_ms', 'p99_r7'),
        ms_column('median_ci95_low_ms', 'median_ci95_low'),
        ms_column('median_ci95_high_ms', 'median_ci95_high'),
        text_column('median_ci95_coverage', 'median_ci95_coverage'),
        text_column('median_ci95_exact', 'median_ci95_exact'),
        // Server side aggregates, reported as they come for traceability.
        // NOT reliable on the extremes: see the comment on Stats.min.
        ms_column('srv_average_ms', 'srv_average'),
        ms_column('srv_minimum_ms', 'srv_minimum'),
        ms_column('srv_maximum_ms', 'srv_maximum'),
        ms_column('srv_slowest_ms', 'srv_slowest')
    ];

    var agg_metric = function(sample) {
        if (sample.kind == 'rpc') {
            return 'rpc:' + (sample.rpc_method || '');
        }
        return sample.phase || '';
    };

    // "cause=count;cause=count", heaviest cause first so the dominant reason
    // is readable without sorting the cell by hand.
    var format_cause_tally = function(tally) {
        return Object.keys(tally).sort(function(left, right) {
            if (tally[right] != tally[left]) {
                return tally[right] - tally[left];
            }
            return (left < right) ? -1 : 1;
        }).map(function(cause) {
            return cause + '=' + tally[cause];
        }).join(';');
    };

    Csv.aggregate = function(campaign) {
        // Pure: groups the samples by scenario x metric x regime and reduces
        // each group with Stats.summary.  Warmup iterations are excluded here
        // (they are measured and marked, never silently dropped: they stay in
        // bench_raw.csv and K is written in bench_meta.csv).
        campaign = campaign || {};
        var samples = campaign.samples || [];
        var meta = campaign.meta || {};
        var groups = {};
        var order = [];
        // Over ALL the samples, warmup included: the concurrency of a screen
        // is a property of the screen, not of whether the iteration counted.
        var peaks = Csv.peak_in_flight(samples);
        samples.forEach(function(sample) {
            if (sample.warmup) {
                return;
            }
            var metric = agg_metric(sample);
            var key = [
                sample.scenario || '',
                sample.kind || '',
                metric,
                sample.regime || ''
            ].join('\u0000');
            var group = groups[key];
            if (!group) {
                group = groups[key] = {
                    run_id: campaign.run_id || meta.run_id || '',
                    arm: sample.arm || meta.arm || '',
                    scenario: sample.scenario || '',
                    kind: sample.kind || '',
                    phase: metric,
                    regime: sample.regime || '',
                    peak_in_flight: peaks[Csv.scenario_key(
                        sample.scenario, sample.regime)],
                    n_invalid: 0,
                    n_cached: 0,
                    causes: {},
                    values: [],
                    srv: null
                };
                order.push(key);
            }
            if (sample.srv) {
                group.srv = sample.srv;
            }
            if (sample.served_from_cache) {
                // A cached call never reached the server: it measures nothing
                // about the network or the WAF.  Counted, not aggregated.
                group.n_cached++;
                return;
            }
            if (!Probe.is_valid(sample)) {
                group.n_invalid++;
                Probe.invalidating_causes(sample).forEach(function(cause) {
                    group.causes[cause] = (group.causes[cause] || 0) + 1;
                });
                return;
            }
            group.values.push(sample.duration_ms);
        });
        return order.map(function(key) {
            var group = groups[key];
            var srv = group.srv || {};
            return jQuery.extend({
                run_id: group.run_id,
                arm: group.arm,
                scenario: group.scenario,
                kind: group.kind,
                phase: group.phase,
                regime: group.regime,
                n_invalid: group.n_invalid,
                n_cached: group.n_cached,
                invalid_causes: format_cause_tally(group.causes),
                peak_in_flight: (group.peak_in_flight === undefined) ?
                    '' : group.peak_in_flight,
                srv_average: srv.average,
                srv_minimum: srv.minimum,
                srv_maximum: srv.maximum,
                srv_slowest: srv.slowest
            }, Stats.summary(group.values));
        });
    };

    Csv.build_meta = function(campaign, options) {
        campaign = campaign || {};
        return Csv.serialize(
            Csv.META_COLUMNS, [campaign.meta || {}], options);
    };

    Csv.build_raw = function(campaign, options) {
        campaign = campaign || {};
        var samples = campaign.samples || [];
        // Derived ONCE for the whole file rather than per row: joinability is
        // a property of a method across the campaign window, so a getter
        // cannot decide it from the row it is handed.
        return Csv.serialize(Csv.RAW_COLUMNS, samples,
            jQuery.extend({}, options, {
                context: {
                    self_overlapping: Csv.self_overlapping_methods(samples)
                }
            }));
    };

    Csv.build_agg = function(campaign, options) {
        return Csv.serialize(
            Csv.AGG_COLUMNS, Csv.aggregate(campaign), options);
    };

    Csv.file_name = function(base, run_id) {
        return run_id ? base + '_' + run_id + '.csv' : base + '.csv';
    };

    Csv.files = function(campaign, options) {
        // The three files share the run_id, both as a column and in the file
        // name, so two campaigns downloaded in a row cannot be confused.
        campaign = campaign || {};
        var run_id = campaign.run_id || (campaign.meta || {}).run_id || '';
        return [
            {
                name: Csv.file_name('bench_meta', run_id),
                content: Csv.build_meta(campaign, options)
            }, {
                name: Csv.file_name('bench_raw', run_id),
                content: Csv.build_raw(campaign, options)
            }, {
                name: Csv.file_name('bench_agg', run_id),
                content: Csv.build_agg(campaign, options)
            }
        ];
    };

    Csv.deliver = function(files) {
        // Strictly sequential delivery: a file is offered only once the
        // previous Download dialog has started to close.  NEVER a loop over
        // download_file -- it opens one modal per file (common.js:4342-4363)
        // and leaks its object URL (common.js:4367, the hidden handler reads
        // this.blob_url off the modal element where it is undefined).  Sao
        // does know how to restack modals (sao.js:1368-1380), but three of
        // them at once is not a deliberate export.
        var dfd = jQuery.Deferred();
        var pending = (files || []).slice();
        var next = function() {
            if (!pending.length) {
                dfd.resolve();
                return;
            }
            var file = pending.shift();
            var before = jQuery('.modal').toArray();
            Sao.common.download_file(file.content, file.name, {
                'type': 'text/csv;charset=utf-8'
            });
            var opened = jQuery('.modal').toArray().filter(function(element) {
                return before.indexOf(element) < 0;
            });
            if (!opened.length) {
                // download_file took its non-modal branch
                // (msSaveOrOpenBlob, common.js:4334): carry on rather than
                // wait for an event that will never fire.
                window.setTimeout(next, 0);
                return;
            }
            // 'hide' and not 'hidden': download_file's own hidden handler
            // removes the element (common.js:4365-4368), which tears down the
            // handlers still queued on it.
            jQuery(opened[0]).one('hide.bs.modal', function() {
                window.setTimeout(next, MODAL_TRANSITION_MS);
            });
        };
        next();
        return dfd.promise();
    };

    Csv.export_campaign = function(campaign, options) {
        if (!campaign || !(campaign.samples || []).length) {
            return Sao.common.message.run(
                Sao.i18n.gettext(
                    'Benchmark: nothing to export, no sample was collected.'),
                'tryton-info');
        }
        return Csv.deliver(Csv.files(campaign, options));
    };

    // ================================================================
    // Probe -- RPC instrumentation, installable and reversible.
    // ================================================================

    var Probe = {};
    Sao.Benchmark.Probe = Probe;

    // The method travels in the URL fragment (rpc.js:188), which is never
    // sent: it is readable on the jQuery settings of a POST (jQuery only
    // strips the hash on requests without a body) but absent from the
    // resource timing entry name -- hence two expressions.
    var RPC_METHOD_RE = /(?:^|\/)rpc\/#(.*)$/;
    var RPC_RESOURCE_RE = /\/rpc\/?(?:[?#]|$)/;

    // The server logs `<class>.<method>` (dispatcher.py:269, :280) where
    // <class> is the model name, that is the client method minus its prefix.
    var SERVER_PREFIXES = ['model.', 'wizard.', 'report.'];

    // Default resource timing buffer is 250 entries, past which entries are
    // dropped silently.  A campaign emits far more than that.
    var RESOURCE_BUFFER_SIZE = 100000;
    var DEFAULT_RESOURCE_BUFFER_SIZE = 250;

    // A resource timing entry carries no identifier of its own, so it is
    // matched on WHEN THE REQUEST STARTED -- narrowed first by the method,
    // which the entry name still exposes (see Probe.resource_entry_fits).
    // entry.startTime is the instant the fetch began: it IDENTIFIES the call,
    // it is not merely "somewhere inside its transport window".  Containment
    // in [_t_start, _t_end] was the original test and it is unsound -- an
    // attempt still in flight has _t_end === null, so its window runs to the
    // present instant and brackets, by construction, every call emitted after
    // it.  On any concurrent burst the head of the queue then absorbed every
    // entry, always, and never said so.
    //
    // jQuery triggers ajaxSend immediately BEFORE transport.send(), and the
    // fetch starts inside send(), so an entry begins a hair AFTER the probe
    // timestamp and essentially never before it.  Hence a deliberately
    // asymmetric tolerance: forward it must cover the send() path, backward it
    // only has to absorb the clamping of performance.now() (~100 us on
    // Chrome, ~1 ms on Firefox).
    var RESOURCE_MATCH_AFTER_MS = 5;
    var RESOURCE_MATCH_BEFORE_MS = 1;

    // Once ajaxComplete has fired, every byte of that response was already in:
    // an entry still downloading after that instant belongs to another call.
    // Usable only against a FINISHED attempt -- one still in flight carries no
    // upper bound at all, which is exactly why containment proved nothing.
    var RESOURCE_MATCH_END_SLACK_MS = 5;

    // An attempt whose response was fully delivered this long ago will never
    // receive an entry (the buffer dropped it, or no observer is running).
    // Dropping it stops it competing for entries that belong to later calls
    // and keeps the queue bounded over a long campaign.  Far above the grace
    // period of Probe.finish().
    var RESOURCE_MATCH_EXPIRY_MS = 5000;

    // Never exclude a sample on its value, always on its cause.
    Probe.INVALIDATING_CAUSES = [
        // Up to 5 attempts, one branch of which blocks the thread
        // (rpc.js:131-155).
        'retry_503',
        // 401 then replay (rpc.js:156-165).
        'auth_401_replay',
        // Open a modal and fold human thinking time into a single RTT
        // (rpc.js:56-66, :89-95).
        'user_warning_modal',
        'concurrency_modal',
        'user_error',
        // Coog branch that resolves with undefined (rpc.js:101-108): a silent
        // failure that would otherwise count as a very fast success.
        'ir_session_silent_relogin',
        'rpc_error',
        'transport_aborted',
        // Correlation broken: no guessed figure, an invalid sample.
        'resource_timing_desync',
        // Several attempts started close enough together that no evidence
        // says which one the entry belongs to.  Recording the ambiguity and
        // emitting nothing is the only honest outcome: picking one hands the
        // WAF sensitive columns (ttfb, sizes, next hop protocol) to the wrong
        // call, and nothing downstream could ever notice.
        'resource_timing_ambiguous',
        // Emitted by the Runner on the row of a scenario that failed: the row
        // must be counted under n_invalid and must never contribute a value.
        'scenario_failed',
        'not_emitted',
        'cache_detection_mismatch',
        // The search matched no record, so there was nothing to render and the
        // phase has no duration.  Invalidating so that Csv.aggregate counts the
        // row under n_invalid and never lets it contribute a value: the phase
        // then shows up with n = 0, visibly present and visibly unmeasured,
        // instead of vanishing from the aggregates altogether.
        'empty_result_set'
    ];

    Probe.installed = false;
    Probe.samples = [];
    // Own in-flight counters.  Sao.common.processing is NOT usable as a
    // quiescence gauge: its `queries` counter is only incremented inside a
    // setTimeout(..., 200) (common.js:3893-3895) and hide() starts with a
    // clearTimeout (common.js:3905), so any RPC under 200 ms increments
    // nothing at all.  It is a spinner.
    // in_flight counts /rpc XHRs only, deliberately: /bus is a distinct route
    // (trytond/bus.py:221) whose long poll would never settle and would make
    // quiescence unreachable.  The methodology requires the bus stopped and
    // records it in bench_meta.csv.
    Probe.in_flight = 0;
    Probe.calls_in_flight = 0;

    var original_rpc = null;
    var wrapper_rpc = null;
    var original_converter = null;
    var observer = null;
    // Kept across uninstall(): end_campaign() and the meta row are often
    // built after the probe has been taken down.
    var observer_available = false;

    var seq_counters = {};
    var sample_context = {};
    var campaign = {};
    var campaign_t0 = 0;
    var call_uid = 0;
    var calls_by_uid = {};
    var active_attempts = [];
    var pending_resource = [];
    var counters = {};
    var resource_desync = false;
    var current_call = null;

    var reset_counters = function() {
        counters = {
            rpc_ajax_send: 0,
            resource_entries: 0,
            orphan_resource_entries: 0,
            ambiguous_resource_entries: 0,
            resource_buffer_full: 0,
            ambiguous_json_parse: 0
        };
    };
    reset_counters();

    var log_failure = function(message, error) {
        // The probe must never be able to break the client it measures.
        Sao.Logger.error('Sao.Benchmark.Probe: ' + message, error);
    };

    var copy_own_properties = function(source, target) {
        for (var key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                target[key] = source[key];
            }
        }
    };

    var split_method = function(rpc_method) {
        var rest = rpc_method || '';
        for (var i = 0; i < SERVER_PREFIXES.length; i++) {
            if (rest.indexOf(SERVER_PREFIXES[i]) === 0) {
                rest = rest.slice(SERVER_PREFIXES[i].length);
                break;
            }
        }
        var cut = rest.lastIndexOf('.');
        if (cut < 0) {
            return {model: '', method: rest};
        }
        return {model: rest.slice(0, cut), method: rest.slice(cut + 1)};
    };

    var snapshot_context = function() {
        return jQuery.extend({
            run_id: campaign.run_id || '',
            arm: campaign.arm || '',
            regime: '',
            scenario: '',
            iteration: '',
            warmup: false
        }, sample_context);
    };

    var add_cause = function(holder, cause) {
        if (!holder || !holder.causes) {
            return;
        }
        if (holder.causes.indexOf(cause) < 0) {
            holder.causes.push(cause);
        }
    };

    // The causes that actually dropped the sample, and only those.  A sample
    // also carries informational causes (resource_timing_missing, the free
    // text error:<message> of a failed scenario): tallying those in the
    // aggregate breakdown would drown the reason the figure is missing under
    // reasons that cost nothing.
    Probe.invalidating_causes = function(sample) {
        var causes = (sample && sample.causes) || [];
        var found = [];
        causes.forEach(function(cause) {
            if ((Probe.INVALIDATING_CAUSES.indexOf(cause) >= 0) ||
                    (String(cause).indexOf('http_') === 0)) {
                found.push(cause);
            }
        });
        return found;
    };

    Probe.is_valid = function(sample) {
        return Probe.invalidating_causes(sample).length === 0;
    };

    var cache_hit = function(args, session) {
        // Replicates the real test of rpc.js:12-20.  Cache.cached(prefix)
        // (session.js:563) is a bare `prefix in store`: it reports a hit for
        // any method ever cached whatever the parameters, so false positives
        // are guaranteed.
        try {
            // Falling back on the current session: verified, no Sao.rpc
            // call site in the client omits the session argument, so this
            // fallback only ever covers a caller from the console.
            var live_session = session || Sao.Session.current_session;
            if (!live_session || !live_session.cache || !args || !args.method) {
                return false;
            }
            if (!live_session.cache.cached(args.method)) {
                return false;
            }
            var params = jQuery.extend([], args.params);
            params.push(jQuery.extend({}, live_session.context, params.pop()));
            // prepareObject read off the live module at call time
            // (rpc.js:17), never captured at install time.
            return live_session.cache.get(
                args.method,
                JSON.stringify(Sao.rpc.prepareObject(params))) !== undefined;
        } catch (error) {
            log_failure('client cache probe failed', error);
            return false;
        }
    };

    var push_sample = function(sample) {
        Probe.samples.push(sample);
        return sample;
    };

    var call_only_sample = function(call) {
        // A call that never reached the wire: a client cache hit, or an early
        // failure.  seq stays EMPTY -- consuming one for a call the server
        // never saw would shift the whole positional join by one and silently
        // falsify the report.
        var split = split_method(call.rpc_method);
        if (!call.served_from_cache) {
            add_cause(call, 'not_emitted');
        }
        return push_sample(jQuery.extend({}, call.context, {
            kind: 'rpc',
            phase: '',
            rpc_method: call.rpc_method,
            srv_model: split.model,
            srv_method: split.method,
            seq: null,
            rpc_id: call.rpc_id,
            attempt: null,
            served_from_cache: call.served_from_cache,
            sync: call.sync,
            t_start_ms: call.t_start - campaign_t0,
            t_end_ms: (call.t_end === null) ? null : call.t_end - campaign_t0,
            _t_start: call.t_start,
            _t_end: call.t_end,
            duration_ms: call.duration_app_ms,
            duration_transport_ms: null,
            duration_app_ms: call.duration_app_ms,
            json_parse_ms: null,
            http_status: null,
            rt: null,
            causes: call.causes
        }));
    };

    // ---- jQuery ajaxSend: emission of every XHR ----

    var on_ajax_send = function(event, jqxhr, settings) {
        try {
            var url = (settings && settings.url) || '';
            var match = RPC_METHOD_RE.exec(url);
            if (!match) {
                return;
            }
            var rpc_method = match[1] || '';
            var call = current_call;
            if (!call && settings._sao_bench_call_uid) {
                // A 503 retry re-issues through jQuery.ajax(this)
                // (rpc.js:143, :152) from a timeout, outside the wrapper: the
                // logical call is recovered through the numeric token carried
                // by the settings object.
                call = calls_by_uid[settings._sao_bench_call_uid] || null;
            }
            if (call) {
                settings._sao_bench_call_uid = call.uid;
                call.emitted = true;
                call.attempt_count++;
            }
            // rpc.js seeds `retries: 0` (rpc.js:195) and increments it on each
            // 503 (rpc.js:132), so it numbers the attempts exactly.
            var attempt_no = (typeof settings.retries == 'number') ?
                settings.retries + 1 : (call ? call.attempt_count : 1);
            // seq: per METHOD counter, campaign scoped, incremented AT
            // EMISSION -- the emission order is what the server log records.
            // 0-based, warmup included, never reset between iterations.
            var seq = seq_counters[rpc_method];
            if (seq === undefined) {
                seq = 0;
            }
            seq_counters[rpc_method] = seq + 1;
            var split = split_method(rpc_method);
            var start = now();
            // The row is created HERE, at emission, and completed in place
            // later: bench_raw.csv therefore comes out in emission order,
            // which is the order the server log records.  Fields prefixed
            // with an underscore are internal and are not CSV columns.
            var attempt = jQuery.extend(snapshot_context(), {
                kind: 'rpc',
                phase: '',
                rpc_method: rpc_method,
                srv_model: split.model,
                srv_method: split.method,
                seq: seq,
                rpc_id: call ? call.rpc_id : null,
                attempt: attempt_no,
                served_from_cache: false,
                sync: call ? call.sync : null,
                t_start_ms: start - campaign_t0,
                t_end_ms: null,
                duration_ms: null,
                duration_app_ms: null,
                duration_transport_ms: null,
                json_parse_ms: null,
                http_status: null,
                rt: null,
                causes: [],
                _t_start: start,
                _t_end: null,
                _call_uid: call ? call.uid : null
            });
            jqxhr._sao_bench_attempt = attempt;
            active_attempts.push(attempt);
            pending_resource.push(attempt);
            if (call) {
                call.samples.push(attempt);
            }
            push_sample(attempt);
            counters.rpc_ajax_send++;
            Probe.in_flight++;
        } catch (error) {
            log_failure('ajaxSend handler failed', error);
        }
    };

    // ---- jQuery ajaxComplete: end of the transport window ----

    var on_ajax_complete = function(event, jqxhr, settings) {
        try {
            var attempt = jqxhr && jqxhr._sao_bench_attempt;
            if (!attempt) {
                return;
            }
            delete jqxhr._sao_bench_attempt;
            attempt._t_end = now();
            attempt.t_end_ms = attempt._t_end - campaign_t0;
            attempt.duration_transport_ms = attempt._t_end - attempt._t_start;
            attempt.duration_ms = attempt.duration_transport_ms;
            attempt.http_status = jqxhr.status;
            var index = active_attempts.indexOf(attempt);
            if (index >= 0) {
                active_attempts.splice(index, 1);
            }
            if (Probe.in_flight > 0) {
                Probe.in_flight--;
            }
            if (jqxhr.status === 0) {
                add_cause(attempt, 'transport_aborted');
            } else if (jqxhr.status == 503) {
                // Whether this attempt produced a server log line is
                // undecidable from the client: a 503 raised by a proxy or the
                // WAF never reached trytond, one raised by trytond did.  Do
                // not guess -- mark it and let the per-method count equality
                // check arbitrate.
                add_cause(attempt, 'retry_503');
            } else if (jqxhr.status == 401) {
                add_cause(attempt, 'auth_401_replay');
            } else if (jqxhr.status >= 400) {
                add_cause(attempt, 'http_' + jqxhr.status);
            }
        } catch (error) {
            log_failure('ajaxComplete handler failed', error);
        }
    };

    // ---- text json converter: pure deserialization cost ----

    var note_json_parse = function(elapsed, converted) {
        if (active_attempts.length != 1) {
            // More than one XHR in flight (or none of ours): charging the
            // wrong attempt would be worse than charging nothing.  The
            // campaign is meant to be strictly serialized, so this is itself
            // a diagnostic.
            if (active_attempts.length > 1) {
                counters.ambiguous_json_parse++;
            }
            return;
        }
        var attempt = active_attempts[0];
        attempt.json_parse_ms = (attempt.json_parse_ms || 0) + elapsed;
        if (!converted || !converted.error) {
            return;
        }
        var kind = converted.error[0];
        var cause = 'rpc_error';
        if (kind == 'UserWarning') {
            cause = 'user_warning_modal';
        } else if (kind == 'ConcurrencyException') {
            cause = 'concurrency_modal';
        } else if (kind == 'UserError') {
            cause = 'user_error';
        } else if (kind == "'ir.session'") {
            cause = 'ir_session_silent_relogin';
        }
        add_cause(attempt, cause);
        add_cause(calls_by_uid[attempt._call_uid], cause);
    };

    var converter_wrapper = function(json) {
        var start = now();
        var converted;
        try {
            converted = original_converter.apply(this, arguments);
        } finally {
            // Timed even when the parse throws, so the in-flight bookkeeping
            // never drifts.
            var elapsed = now() - start;
            try {
                note_json_parse(elapsed, converted);
            } catch (error) {
                log_failure('json converter probe failed', error);
            }
        }
        return converted;
    };

    // ---- PerformanceObserver: network decomposition ----

    var attach_resource = function(attempt, entry) {
        if (!entry.requestStart) {
            // Sub-timings withheld (no Timing-Allow-Origin): keep the sizes
            // and the protocol, blank the decomposition rather than write
            // zeros that read as instant network.
            attempt.rt = {
                next_hop_protocol: entry.nextHopProtocol,
                transfer_size: entry.transferSize,
                encoded_body_size: entry.encodedBodySize,
                decoded_body_size: entry.decodedBodySize,
                duration_ms: entry.duration,
                dns_ms: null,
                connect_ms: null,
                tls_ms: null,
                request_ms: null,
                ttfb_ms: null,
                response_ms: null
            };
            return;
        }
        attempt.rt = {
            next_hop_protocol: entry.nextHopProtocol,
            transfer_size: entry.transferSize,
            encoded_body_size: entry.encodedBodySize,
            decoded_body_size: entry.decodedBodySize,
            duration_ms: entry.duration,
            dns_ms: entry.domainLookupEnd - entry.domainLookupStart,
            connect_ms: entry.connectEnd - entry.connectStart,
            tls_ms: entry.secureConnectionStart ?
                entry.connectEnd - entry.secureConnectionStart : 0,
            request_ms: entry.responseStart - entry.requestStart,
            ttfb_ms: entry.responseStart - entry.startTime,
            response_ms: entry.responseEnd - entry.responseStart
        };
    };

    // Could this entry belong to this attempt?  Three constraints, all of
    // them exact or physical, and deliberately no notion of preference: the
    // answer is "possible" or "impossible", never "likeliest".
    Probe.resource_entry_fits = function(entry, attempt) {
        if (!entry || !attempt || (typeof attempt._t_start != 'number') ||
                (typeof entry.startTime != 'number')) {
            return false;
        }
        // The method survives into entry.name.  rpc.js:188 writes it in the
        // url fragment; the fragment is never TRANSMITTED, but a resource
        // entry is named after the url the fetch was created with, so it is
        // still readable on the client side.  Measured against real trytond
        // traffic under Chromium: 20 entries out of 20 carried it, and it
        // agreed with the ajaxSend url every time.
        //
        // Used strictly as a narrowing test, and only when the entry really
        // exposes a method: a browser that strips the fragment must degrade
        // to the timing evidence alone, never to a wrong exclusion.  Two
        // concurrent calls on DIFFERENT methods therefore separate exactly;
        // a method overlapping itself -- the four search_count of a form
        // (form.js:1194-1226) -- stays undecidable, and is reported as such.
        var entry_method = RPC_METHOD_RE.exec(entry.name || '');
        if (entry_method && attempt.rpc_method &&
                (entry_method[1] !== attempt.rpc_method)) {
            return false;
        }
        // The request cannot have started before its own ajaxSend, and it
        // starts very shortly after it.  Measured on the same traffic: the
        // delta ran from 0 to 0.4 ms, never negative, never above 1 ms.
        var start = entry.startTime;
        if ((start < attempt._t_start - RESOURCE_MATCH_BEFORE_MS) ||
                (start > attempt._t_start + RESOURCE_MATCH_AFTER_MS)) {
            return false;
        }
        if (typeof attempt._t_end == 'number') {
            // The attempt is over, so its response was complete by then.
            var end = (typeof entry.responseEnd == 'number') ?
                entry.responseEnd : start + (entry.duration || 0);
            if (end > attempt._t_end + RESOURCE_MATCH_END_SLACK_MS) {
                return false;
            }
        }
        return true;
    };

    // No entry can still be coming for an attempt whose response was fully
    // delivered this long ago.
    Probe.resource_entry_expired = function(attempt, t_now) {
        return Boolean(attempt) && (typeof attempt._t_end == 'number') &&
            ((t_now - attempt._t_end) > RESOURCE_MATCH_EXPIRY_MS);
    };

    // Verdict of the correlation for one entry against the attempts still
    // waiting for theirs.  Pure, and the single place the decision is taken.
    //
    //   matched   -- exactly one attempt can own the entry
    //   ambiguous -- several can, and nothing tells them apart
    //   orphan    -- none can
    //
    // An ambiguity is NOT broken by ranking the candidates on proximity.
    // Calls emitted in the same synchronous pass sit microseconds apart while
    // performance.now() is clamped to ~100 us: such a ranking would be noise
    // wearing the costume of evidence, and it would produce exactly the kind
    // of plausible wrong figure this plugin exists to avoid.
    Probe.match_resource_entry = function(entry, candidates) {
        var eligible = [];
        (candidates || []).forEach(function(candidate) {
            if (Probe.resource_entry_fits(entry, candidate)) {
                eligible.push(candidate);
            }
        });
        if (eligible.length === 1) {
            return {
                verdict: 'matched',
                attempt: eligible[0],
                eligible: eligible
            };
        }
        return {
            verdict: (eligible.length === 0) ? 'orphan' : 'ambiguous',
            attempt: null,
            eligible: eligible
        };
    };

    var drop_pending = function(attempts) {
        if (!attempts.length) {
            return;
        }
        pending_resource = pending_resource.filter(function(attempt) {
            return attempts.indexOf(attempt) < 0;
        });
    };

    var on_resource_entries = function(list) {
        try {
            list.getEntries().forEach(function(entry) {
                if ((entry.initiatorType != 'xmlhttprequest') &&
                        (entry.initiatorType != 'fetch')) {
                    return;
                }
                if (!RPC_RESOURCE_RE.test(entry.name || '')) {
                    return;
                }
                counters.resource_entries++;
                // No entry carries an identifier of its own: the two keys
                // available are the method read off the url fragment and the
                // instant the request started.  Neither is required to be
                // discriminating on its own, so the verdict may well be "I
                // cannot tell" -- and then nothing is attributed.
                var t_now = now();
                pending_resource = pending_resource.filter(function(attempt) {
                    return !Probe.resource_entry_expired(attempt, t_now);
                });
                var match = Probe.match_resource_entry(entry, pending_resource);
                if (match.verdict == 'matched') {
                    drop_pending([match.attempt]);
                    attach_resource(match.attempt, entry);
                    return;
                }
                if (match.verdict == 'ambiguous') {
                    // Every candidate loses its decomposition and none
                    // receives this one.  Leaving them queued would only let
                    // the next entry face the same undecidable set.
                    counters.ambiguous_resource_entries++;
                    match.eligible.forEach(function(candidate) {
                        add_cause(candidate, 'resource_timing_ambiguous');
                    });
                    drop_pending(match.eligible);
                    return;
                }
                counters.orphan_resource_entries++;
                resource_desync = true;
            });
        } catch (error) {
            log_failure('resource observer failed', error);
        }
    };

    var on_buffer_full = function() {
        counters.resource_buffer_full++;
        resource_desync = true;
    };

    // ---- Sao.rpc envelope ----

    var build_wrapper = function() {
        // Named parameters only for readability: the call is forwarded with
        // `arguments`, so the ES6 defaults of rpc.js:6 still apply to the
        // arguments the caller actually omitted.
        return function(args, session, async, process_exception) {
            var call = {
                uid: ++call_uid,
                rpc_method: (args && args.method) || '',
                sync: async === false,
                context: snapshot_context(),
                t_start: now(),
                t_end: null,
                duration_app_ms: null,
                rpc_id: null,
                served_from_cache: false,
                emitted: false,
                attempt_count: 0,
                samples: [],
                causes: []
            };
            // Sao.rpc.id read off the live module (rpc.js:29, :206), never
            // captured at install time.  It is the id the original is about to
            // allocate -- unless it returns early on a cache hit.
            var id_before = Sao.rpc.id;
            call.served_from_cache = cache_hit(args, session);
            calls_by_uid[call.uid] = call;
            var previous_call = current_call;
            current_call = call;
            Probe.calls_in_flight++;
            var settled = false;
            var settle = function() {
                if (settled) {
                    return;
                }
                settled = true;
                if (Probe.calls_in_flight > 0) {
                    Probe.calls_in_flight--;
                }
                call.t_end = now();
                call.duration_app_ms = call.t_end - call.t_start;
                if (call.samples.length) {
                    // The application duration spans the whole logical call,
                    // retries included.  Written on the LAST attempt only:
                    // repeating it would double count in any spreadsheet sum.
                    var last = call.samples[call.samples.length - 1];
                    last.duration_app_ms = call.duration_app_ms;
                    call.samples.forEach(function(sample) {
                        call.causes.forEach(function(cause) {
                            add_cause(sample, cause);
                        });
                    });
                } else {
                    call_only_sample(call);
                }
                delete calls_by_uid[call.uid];
            };
            var deferred_tracked = false;
            try {
                var result = original_rpc.apply(this, arguments);
                if (result && (typeof result.always == 'function')) {
                    result.always(settle);
                    deferred_tracked = true;
                }
                return result;
            } finally {
                // try/finally is mandatory: the synchronous mode THROWS the
                // deferred (rpc.js:199-203).  Without it the in-flight counter
                // desynchronizes and the whole correlation drifts.
                current_call = previous_call;
                var emitted_by_id = Sao.rpc.id !== id_before;
                if (emitted_by_id == call.served_from_cache) {
                    // The replicated cache test and the id allocation
                    // disagree: something changed under us, do not trust the
                    // sample.
                    add_cause(call, 'cache_detection_mismatch');
                }
                call.rpc_id = emitted_by_id ? id_before : null;
                call.samples.forEach(function(sample) {
                    sample.rpc_id = call.rpc_id;
                });
                if (!deferred_tracked) {
                    settle();
                }
            }
        };
    };

    // ---- install / uninstall ----

    Probe.install = function() {
        if (Probe.installed) {
            return false;
        }
        original_rpc = Sao.rpc;
        wrapper_rpc = build_wrapper();
        // rpc.js keeps `id` (rpc.js:206), `convertJSONObject` (:208) and
        // `prepareObject` (:253) on the function object itself, and its own
        // body reads them through the live `Sao.rpc` binding.  While the
        // wrapper is in place they must live on the wrapper.
        copy_own_properties(original_rpc, wrapper_rpc);
        Sao.rpc = wrapper_rpc;

        original_converter = jQuery.ajaxSettings.converters['text json'];
        jQuery.ajaxSetup({
            converters: {
                'text json': converter_wrapper
            }
        });

        jQuery(document)
            .on('ajaxSend', on_ajax_send)
            .on('ajaxComplete', on_ajax_complete);

        if (window.performance) {
            if (window.performance.setResourceTimingBufferSize) {
                window.performance.setResourceTimingBufferSize(
                    RESOURCE_BUFFER_SIZE);
            }
            if (window.performance.addEventListener) {
                window.performance.addEventListener(
                    'resourcetimingbufferfull', on_buffer_full);
            }
        }
        if (typeof PerformanceObserver != 'undefined') {
            try {
                observer = new PerformanceObserver(on_resource_entries);
                observer.observe({type: 'resource', buffered: false});
                observer_available = true;
            } catch (error) {
                log_failure('PerformanceObserver unavailable', error);
                observer = null;
                observer_available = false;
            }
        } else {
            observer_available = false;
        }

        Probe.installed = true;
        return true;
    };

    Probe.uninstall = function() {
        // Idempotent: a second call does nothing and raises nothing.
        if (!Probe.installed) {
            return false;
        }
        Probe.installed = false;

        if (wrapper_rpc && original_rpc) {
            // Hand back everything the wrapper accumulated, starting with the
            // JSON-RPC counter that rpc.js kept incrementing on it.
            copy_own_properties(wrapper_rpc, original_rpc);
            if (Sao.rpc !== wrapper_rpc) {
                log_failure(
                    'Sao.rpc was replaced while the probe was installed;' +
                    ' restoring the original anyway', null);
            }
            Sao.rpc = original_rpc;
        }
        if (original_converter) {
            jQuery.ajaxSetup({
                converters: {
                    'text json': original_converter
                }
            });
        }
        jQuery(document)
            .off('ajaxSend', on_ajax_send)
            .off('ajaxComplete', on_ajax_complete);
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (window.performance) {
            if (window.performance.removeEventListener) {
                window.performance.removeEventListener(
                    'resourcetimingbufferfull', on_buffer_full);
            }
            if (window.performance.setResourceTimingBufferSize) {
                window.performance.setResourceTimingBufferSize(
                    DEFAULT_RESOURCE_BUFFER_SIZE);
            }
        }

        original_rpc = null;
        wrapper_rpc = null;
        original_converter = null;
        current_call = null;
        calls_by_uid = {};
        active_attempts = [];
        pending_resource = [];
        Probe.in_flight = 0;
        Probe.calls_in_flight = 0;
        return true;
    };

    // ---- campaign lifecycle ----

    Probe.new_run_id = function() {
        return moment().format('YYYYMMDD-HHmmss') + '-' +
            Math.random().toString(36).slice(2, 6);
    };

    Probe.environment = function() {
        var session = Sao.Session.current_session;
        var viewport = window.visualViewport;
        var screen_ = window.screen;
        var isolated = (typeof self.crossOriginIsolated == 'boolean') ?
            self.crossOriginIsolated : null;
        return {
            sao_version: Sao.__version__,
            user_agent: navigator.userAgent,
            platform: navigator.platform || '',
            language: Sao.i18n.getlang ? Sao.i18n.getlang() : '',
            // performance.now() is clamped when the page is not cross-origin
            // isolated (~100 us on Chrome, ~1 ms on Firefox): no sub
            // millisecond delta on a single iteration is reportable.
            cross_origin_isolated: isolated,
            // A hidden tab throttles setTimeout to 1 Hz, and the jQuery
            // .then() chain IS setTimeout based: the whole client collapses,
            // not just the instrument.
            visibility_state: document.visibilityState,
            window_width: window.innerWidth,
            window_height: window.innerHeight,
            viewport_width: viewport ? viewport.width : null,
            viewport_height: viewport ? viewport.height : null,
            screen_width: screen_ ? screen_.width : null,
            screen_height: screen_ ? screen_.height : null,
            device_pixel_ratio: window.devicePixelRatio,
            config_limit: Sao.config.limit,
            config_display_size: Sao.config.display_size,
            database: session ? session.database : '',
            user_id: session ? session.user_id : '',
            login: session ? session.login : '',
            performance_observer_available: observer_available
        };
    };

    Probe.start_campaign = function(info) {
        Probe.samples = [];
        seq_counters = {};
        sample_context = {};
        calls_by_uid = {};
        active_attempts = [];
        pending_resource = [];
        current_call = null;
        Probe.in_flight = 0;
        Probe.calls_in_flight = 0;
        resource_desync = false;
        reset_counters();
        campaign_t0 = now();
        campaign = jQuery.extend({
            run_id: Probe.new_run_id(),
            arm: '',
            started_at: new Date().toISOString(),
            finished_at: '',
            iterations: '',
            warmup_k: '',
            plan_entries: '',
            server_version: '',
            container_width: '',
            container_height: '',
            bus_stopped: '',
            notes: ''
        }, info || {});
        if (window.performance && window.performance.clearResourceTimings) {
            window.performance.clearResourceTimings();
        }
        return campaign;
    };

    Probe.set_context = function(fields) {
        // Applied to every sample emitted from now on: scenario, iteration,
        // regime (cold / warm) and the warmup flag.  Snapshotted at emission,
        // so a sample keeps the context it was started in.
        sample_context = jQuery.extend({}, sample_context, fields || {});
        return sample_context;
    };

    Probe.add_phase_sample = function(fields) {
        var sample = jQuery.extend({
            kind: 'phase',
            phase: '',
            rpc_method: '',
            srv_model: '',
            srv_method: '',
            seq: null,
            rpc_id: null,
            attempt: null,
            served_from_cache: false,
            sync: null,
            t_start_ms: null,
            t_end_ms: null,
            duration_ms: null,
            duration_app_ms: null,
            duration_transport_ms: null,
            json_parse_ms: null,
            http_status: null,
            rt: null
        }, snapshot_context(), fields || {});
        if (!sample.causes) {
            sample.causes = [];
        }
        return push_sample(sample);
    };

    Probe.elapsed = function(timestamp) {
        // Turns an absolute performance.now() reading into the campaign
        // relative milliseconds every CSV row is expressed in.  Needed by
        // the Driver, whose render phases are timed outside the RPC path.
        return timestamp - campaign_t0;
    };

    Probe.is_quiet = function() {
        return (Probe.in_flight === 0) && (Probe.calls_in_flight === 0);
    };

    Probe.end_campaign = function() {
        campaign.finished_at = new Date().toISOString();
        if (observer_available &&
                (counters.rpc_ajax_send != counters.resource_entries)) {
            // Count mismatch between ajaxSend and the observed entries: the
            // correlation cannot be trusted for the entries that are
            // missing.  Only meaningful when an observer was actually
            // running -- a browser without PerformanceObserver simply has no
            // network decomposition, which is not a desynchronization and
            // must not invalidate the whole campaign.
            resource_desync = true;
        }
        Probe.samples.forEach(function(sample) {
            if ((sample.kind != 'rpc') || (sample.seq === null)) {
                return;
            }
            if (!sample.rt) {
                // Not invalidating on its own: the transport window is still
                // measured, only its decomposition is unavailable.
                add_cause(sample, 'resource_timing_missing');
                if (resource_desync && (sample.causes.indexOf(
                        'resource_timing_ambiguous') < 0)) {
                    // A sample already excluded for a precise, localised
                    // reason keeps that reason alone: the campaign wide flag
                    // would only tally the same exclusion a second time.
                    add_cause(sample, 'resource_timing_desync');
                }
            }
        });
        return Probe.campaign();
    };

    Probe.finish = function(delay) {
        // Resource timing entries are delivered asynchronously, so a short
        // grace period is left for the stragglers before finalizing.
        var dfd = jQuery.Deferred();
        window.setTimeout(function() {
            dfd.resolve(Probe.end_campaign());
        }, (delay === undefined) ? 250 : delay);
        return dfd.promise();
    };

    var dominant_protocol = function() {
        var tally = {};
        var best = '';
        var best_count = 0;
        Probe.samples.forEach(function(sample) {
            if (!sample.rt || !sample.rt.next_hop_protocol) {
                return;
            }
            var protocol = sample.rt.next_hop_protocol;
            tally[protocol] = (tally[protocol] || 0) + 1;
            if (tally[protocol] > best_count) {
                best_count = tally[protocol];
                best = protocol;
            }
        });
        return best;
    };

    Probe.campaign = function() {
        return {
            run_id: campaign.run_id,
            meta: jQuery.extend({}, Probe.environment(), campaign, {
                next_hop_protocol: dominant_protocol(),
                sample_count: Probe.samples.length,
                rpc_ajax_send_count: counters.rpc_ajax_send,
                resource_entry_count: counters.resource_entries,
                orphan_resource_entries: counters.orphan_resource_entries,
                ambiguous_resource_entries:
                    counters.ambiguous_resource_entries,
                resource_timing_desync: resource_desync,
                resource_buffer_full: counters.resource_buffer_full,
                ambiguous_json_parse: counters.ambiguous_json_parse
            }),
            samples: Probe.samples
        };
    };

    Probe.take_samples = function() {
        var samples = Probe.samples;
        Probe.samples = [];
        return samples;
    };

    Probe.status = function() {
        return {
            installed: Probe.installed,
            run_id: campaign.run_id || '',
            samples: Probe.samples.length,
            in_flight: Probe.in_flight,
            calls_in_flight: Probe.calls_in_flight,
            pending_resource: pending_resource.length,
            active_attempts: active_attempts.length,
            resource_desync: resource_desync,
            counters: jQuery.extend({}, counters),
            seq_counters: jQuery.extend({}, seq_counters)
        };
    };

    // ================================================================
    // Driver -- replay of one plan entry on a detached, off-screen Screen.
    // ================================================================

    var Driver = {};
    Sao.Benchmark.Driver = Driver;

    // Geometry of the off-screen container.  Attached to document.body AND
    // dimensioned is mandatory: detached from the document -- or display:none
    // -- every layout read (offsetWidth / offsetHeight) returns 0, and
    // Sao.View.Tree derives its visible row count from the height, so the
    // whole render would be measured on an empty skeleton.  Out of the visual
    // flow, but laid out.
    Driver.CONTAINER_WIDTH = 1280;
    Driver.CONTAINER_HEIGHT = 900;

    // Stabilization window of the quiescence detector.  It MUST cover the
    // 250 ms timer of tree.js:1212: update_with_selection is never actually
    // debounced, because Sao.common.debounce (common.js:4415-4422) stores the
    // timer on a bind()-ed function recreated at every call, so the
    // clearTimeout never finds anything to cancel.
    Driver.SETTLE_MS = 400;
    Driver.POLL_MS = 25;
    // Inter iteration gap, strictly greater than that same 250 ms timer:
    // below it, the tail of one iteration runs inside the next one and
    // inflates it silently.
    Driver.GAP_MS = 350;
    Driver.QUIESCENCE_TIMEOUT_MS = 120000;
    // requestAnimationFrame never fires in a background tab.  The methodology
    // requires a foreground tab and records document.visibilityState, but the
    // driver must not hang if the operator switches away: the paint sample is
    // then flagged instead of being waited for forever.
    Driver.PAINT_TIMEOUT_MS = 2000;

    var driver_installed = false;
    var io_original_observe = null;
    var io_wrapper_observe = null;
    var io_watched = [];
    var containers = [];
    var action_ids = {};

    var always_true = function() {
        return true;
    };

    // ---- off-screen container ----

    var inside_a_container = function(node) {
        for (var i = 0; i < containers.length; i++) {
            var root = containers[i];
            if ((root === node) ||
                    (root.contains && root.contains(node))) {
                return true;
            }
        }
        return false;
    };

    var new_container = function(width, height) {
        // Never display:none and never detached, for the reason above.  Out of
        // sight through a large negative offset, which in a left-to-right
        // document creates no scrollable area either.
        var el = jQuery('<div/>', {
            'class': 'sao-benchmark-offscreen',
            'aria-hidden': 'true'
        }).css({
            'position': 'absolute',
            'top': '0',
            'left': '-10000px',
            'width': width + 'px',
            'height': height + 'px',
            'overflow': 'hidden'
        });
        el.appendTo(document.body);
        containers.push(el[0]);
        return el;
    };

    // ---- SortableJS registrations of the draggable trees ----

    // Sao.View.Tree._add_drag_n_drop (view/tree.js:747-754) calls
    // Sortable.create on the tbody of every draggable tree -- and keeps no
    // reference to the instance it gets back.  SortableJS holds each element
    // in a module level `sortables` array (Sortable.js:888, pushed :1149)
    // whose only exit is destroy() (:2171), which needs that instance.  Since
    // holding one node of a detached tree holds the WHOLE tree, every
    // iteration left its entire rendered screen alive: the live DOM set grew
    // without bound and, with it, the cost of every DOM operation of the
    // client -- which is why all the pure client phases degraded by the same
    // factor while document.querySelectorAll('*') stayed flat.
    //
    // The instance is reachable from its element (Sortable.get, :2385), so the
    // driver destroys, at teardown, exactly the registrations sitting inside
    // its own container.  Nothing global is patched and nothing is installed:
    // an element of the visible interface is never inside a container, so
    // normal navigation -- and the same leak in a real Tab, which is Sao's to
    // fix and not the benchmark's -- is left strictly alone.
    var sortable_instances = function(root) {
        var found = [];
        if (!root || (typeof Sortable == 'undefined') ||
                (typeof Sortable.get != 'function')) {
            return found;
        }
        var take = function(node) {
            var instance;
            try {
                instance = Sortable.get(node);
            } catch (error) {
                return;
            }
            if (instance && (typeof instance.destroy == 'function')) {
                found.push(instance);
            }
        };
        take(root);
        var nodes = (typeof root.querySelectorAll == 'function') ?
            root.querySelectorAll('*') : [];
        for (var i = 0; i < nodes.length; i++) {
            take(nodes[i]);
        }
        return found;
    };

    // destroy() clears the expando it is found by, so a second pass over the
    // same subtree finds nothing: idempotent, like the rest of the teardown.
    var release_sortables = function(root) {
        var instances = sortable_instances(root);
        instances.forEach(function(instance) {
            try {
                instance.destroy();
            } catch (error) {
                log_failure('Sortable destroy failed', error);
            }
        });
        return instances.length;
    };

    var count_live_sortables = function() {
        var total = 0;
        containers.forEach(function(node) {
            total += sortable_instances(node).length;
        });
        return total;
    };

    var drop_container = function(el) {
        if (!el || !el.length) {
            return;
        }
        var node = el[0];
        release_observers(node);
        release_sortables(node);
        var index = containers.indexOf(node);
        if (index >= 0) {
            containers.splice(index, 1);
        }
        el.remove();
    };

    var remove_all_containers = function() {
        release_observers(null);
        jQuery('.sao-benchmark-offscreen').each(function() {
            release_sortables(this);
        });
        jQuery('.sao-benchmark-offscreen').remove();
        containers = [];
    };

    // ---- IntersectionObserver of the "More" row ----

    // tree.js:7 builds ONE module level IntersectionObserver, shared by every
    // tree of the client and closed over inside the tree.js IIFE.  It is
    // therefore not reachable from here -- and disconnect()-ing it, could we
    // reach it, would kill the "More" auto load of the real client for good.
    // What the spec asks for (leave no observer watching our rows, so that the
    // observer of one iteration cannot auto-click "More" -- tree.js:1187 --
    // during the next one and inflate it silently) is obtained instead by
    // recording, while a run is in progress, every observe() whose target sits
    // inside one of our containers, and calling unobserve() on exactly those
    // at teardown.  Reversible, and it never touches a target of the visible
    // interface.
    var install_intersection_patch = function() {
        if (io_original_observe ||
                (typeof IntersectionObserver == 'undefined')) {
            return;
        }
        try {
            var prototype = IntersectionObserver.prototype;
            var original = prototype.observe;
            io_original_observe = original;
            io_wrapper_observe = function(target) {
                try {
                    if (target && inside_a_container(target)) {
                        io_watched.push({observer: this, target: target});
                    }
                } catch (error) {
                    log_failure('IntersectionObserver bookkeeping failed',
                        error);
                }
                return original.apply(this, arguments);
            };
            prototype.observe = io_wrapper_observe;
        } catch (error) {
            log_failure('IntersectionObserver patch failed', error);
            io_original_observe = null;
            io_wrapper_observe = null;
        }
    };

    var restore_intersection_patch = function() {
        if (!io_original_observe) {
            return;
        }
        if (IntersectionObserver.prototype.observe === io_wrapper_observe) {
            IntersectionObserver.prototype.observe = io_original_observe;
        } else {
            log_failure(
                'IntersectionObserver.observe was replaced while the driver' +
                ' was installed; leaving the current one in place', null);
        }
        io_original_observe = null;
        io_wrapper_observe = null;
    };

    var release_observers = function(root) {
        var kept = [];
        io_watched.forEach(function(entry) {
            var mine = !root || (entry.target === root) ||
                (root.contains && root.contains(entry.target));
            if (!mine) {
                kept.push(entry);
                return;
            }
            try {
                entry.observer.unobserve(entry.target);
            } catch (error) {
                log_failure('IntersectionObserver unobserve failed', error);
            }
        });
        io_watched = kept;
    };

    Driver.install = function() {
        if (driver_installed) {
            return false;
        }
        install_intersection_patch();
        driver_installed = true;
        return true;
    };

    Driver.uninstall = function() {
        // Idempotent, and safe to call after a failure: it is what guarantees
        // that document.body holds no residual container and that no observer
        // of ours is still watching anything.
        if (!driver_installed) {
            remove_all_containers();
            return false;
        }
        driver_installed = false;
        remove_all_containers();
        restore_intersection_patch();
        return true;
    };

    Driver.status = function() {
        return {
            installed: driver_installed,
            containers: containers.length,
            dom_containers: jQuery('.sao-benchmark-offscreen').length,
            watched_targets: io_watched.length,
            // Registrations still held by SortableJS inside our containers.
            // Zero once the containers are gone -- and a residual here would
            // name the leak of task 07 coming back, instead of leaving it to
            // be re-diagnosed from a slope in the timings.
            live_sortables: count_live_sortables(),
            action_ids: jQuery.extend({}, action_ids)
        };
    };

    // ---- timing primitives ----

    var wait = function(delay) {
        var dfd = jQuery.Deferred();
        window.setTimeout(function() {
            dfd.resolve();
        }, delay);
        return dfd.promise();
    };

    Driver.gap = function(delay) {
        return wait((delay === undefined) ? Driver.GAP_MS : delay);
    };

    // Double requestAnimationFrame: the first callback runs before the frame
    // is composited, the second one after it.  A valid end of render marker
    // here because Sao uses NO rAF at all, so nothing of its own can be queued
    // in between; it overestimates by at most one frame (~16.7 ms).
    var next_paint = function() {
        var dfd = jQuery.Deferred();
        var t0 = now();
        var settled = false;
        var guard = null;
        var settle = function(observed) {
            if (settled) {
                return;
            }
            settled = true;
            if (guard !== null) {
                window.clearTimeout(guard);
                guard = null;
            }
            dfd.resolve({t_start: t0, t_end: now(), observed: observed});
        };
        guard = window.setTimeout(function() {
            settle(false);
        }, Driver.PAINT_TIMEOUT_MS);
        if (typeof window.requestAnimationFrame != 'function') {
            settle(false);
        } else {
            window.requestAnimationFrame(function() {
                window.requestAnimationFrame(function() {
                    settle(true);
                });
            });
        }
        return dfd.promise();
    };

    var make_watcher = function() {
        var watcher = {last_activity: now()};
        watcher.note = function() {
            watcher.last_activity = now();
        };
        return watcher;
    };

    // The only honest end of render signal, because Sao offers none:
    //   - no RPC in flight (the in-flight counters held by the Probe), AND
    //   - no Screen.display / Tree.display / Tree.redraw observed for a full
    //     settle window, THEN
    //   - a double requestAnimationFrame.
    // Screen.display() is deliberately NOT usable as a bound: the .done() of
    // set_tree_state (screen.js:2548) returns the same promise and throws the
    // callback return value away, so the SECOND full tree render
    // (screen.js:2555) is never awaited -- and since clear() resets
    // tree_states_done (screen.js:1650), EVERY search_filter pays for two
    // renders, not just the first one.  Sao.Tab.create(...).then() is worse
    // still: it resolves before any data is loaded (tab.js:578, :597, :455).
    var wait_quiet = function(watcher, timeout) {
        var dfd = jQuery.Deferred();
        var t0 = now();
        var limit = (timeout === undefined) ?
            Driver.QUIESCENCE_TIMEOUT_MS : timeout;
        var poll = function() {
            var current = now();
            if (!Probe.is_quiet()) {
                watcher.note();
            }
            if ((current - watcher.last_activity) >= Driver.SETTLE_MS) {
                dfd.resolve({quiet_at: current, timed_out: false});
                return;
            }
            if ((current - t0) >= limit) {
                dfd.resolve({quiet_at: current, timed_out: true});
                return;
            }
            window.setTimeout(poll, Driver.POLL_MS);
        };
        poll();
        return dfd.promise();
    };

    // ---- measurement state ----

    var new_state = function(watcher) {
        return {
            stage: 'list',
            watcher: watcher,
            marks: {},
            tree: null,
            view_rpc_end: null,
            load_start: null,
            construct_end: null,
            redraw_end: null,
            construct_calls: 0,
            redraw_calls: 0,
            render_passes: 0
        };
    };

    // Only the FIRST occurrence of a phase is kept; the repeats are counted.
    // A second occurrence is never an average: on a list, the second render is
    // a different event (a warm redraw), and folding it into the first would
    // produce the plausible-but-wrong figure this whole plugin exists to
    // avoid.
    var mark = function(state, phase, t_start, t_end) {
        var existing = state.marks[phase];
        if (existing) {
            existing.repeats++;
            return existing;
        }
        state.marks[phase] = {
            t_start: t_start,
            t_end: t_end,
            repeats: 0,
            emitted: false
        };
        return state.marks[phase];
    };

    // tree_display mixes DOM work with the 1..N record.load() reads that
    // redraw_async interleaves (tree.js:1766-1771).  Subtracting the union of
    // the RPC transport windows overlapping the interval isolates the client
    // side part.  Union and not sum: the campaign is serialized so they should
    // not overlap, but a 503 retry can make them.
    var rpc_busy_between = function(t_start, t_end, from_index) {
        var spans = [];
        var samples = Probe.samples;
        var i;
        for (i = from_index; i < samples.length; i++) {
            var sample = samples[i];
            if ((sample.kind != 'rpc') ||
                    (typeof sample._t_start != 'number')) {
                continue;
            }
            var end = (typeof sample._t_end == 'number') ?
                sample._t_end : t_end;
            var a = Math.max(sample._t_start, t_start);
            var b = Math.min(end, t_end);
            if (b > a) {
                spans.push([a, b]);
            }
        }
        spans.sort(function(left, right) {
            return left[0] - right[0];
        });
        var total = 0;
        var cursor = null;
        spans.forEach(function(span) {
            if ((cursor === null) || (span[0] >= cursor)) {
                total += span[1] - span[0];
                cursor = span[1];
            } else if (span[1] > cursor) {
                total += span[1] - cursor;
                cursor = span[1];
            }
        });
        return total;
    };

    // Nature and count of the RPCs issued by one iteration.  Half of what the
    // early validation gate compares between a detached iteration and a real
    // tab opening; the other half is the row count.
    var rpc_breakdown = function(from_index) {
        var tally = {};
        var order = [];
        var samples = Probe.samples;
        var i;
        for (i = from_index; i < samples.length; i++) {
            var sample = samples[i];
            if (sample.kind != 'rpc') {
                continue;
            }
            var key = sample.rpc_method || '';
            if (tally[key] === undefined) {
                tally[key] = 0;
                order.push(key);
            }
            tally[key]++;
        }
        return order.map(function(key) {
            return {method: key, count: tally[key]};
        });
    };

    // `duration` overrides the bounds difference, for a phase whose value is
    // corrected (tree_display_net): the row then keeps the REAL interval in
    // t_start_ms / t_end_ms and carries the corrected figure in duration_ms,
    // rather than a fabricated end instant that never happened.
    var emit_phase = function(phases, phase, t_start, t_end, duration, extra) {
        if (duration === undefined) {
            duration = t_end - t_start;
        }
        phases[phase] = duration;
        Probe.add_phase_sample(jQuery.extend({
            phase: phase,
            t_start_ms: Probe.elapsed(t_start),
            t_end_ms: Probe.elapsed(t_end),
            duration_ms: duration
        }, extra || {}));
        return duration;
    };

    // Idempotent on purpose: a form stage that fails re-enters through the
    // error path, which asks for every mark again.  A phase must produce
    // exactly one row, or the aggregate would count the same render twice.
    var emit_marks = function(state, phases, order) {
        order.forEach(function(phase) {
            var m = state.marks[phase];
            if (!m || m.emitted) {
                return;
            }
            m.emitted = true;
            emit_phase(phases, phase, m.t_start, m.t_end);
        });
    };

    // ---- instrumentation ----

    // Which model calls become a phase, and under which bounds.  Shared by the
    // instance level hook (detached driver) and the prototype level one (real
    // tab), so the two arms of the comparison gate cannot drift apart: a phase
    // measured on one side is measured the same way on the other.
    var mark_model_call = function(state, method, t0, t1, asynchronous) {
        if (method == 'fields_view_get') {
            // view: emission -> response of fields_view_get
            // (screen.js:937-939).  Network + WAF + server + parse.
            // Restricted to the ASYNCHRONOUS call, which is the one
            // add_view_id makes (screen.js:937): the domain parser getter
            // fires its own fields_view_get in SYNCHRONOUS mode
            // (screen.js:1938-1940), and letting it in would time a frozen
            // thread and then hand add_view a stale start.
            if (!asynchronous) {
                return;
            }
            state.view_rpc_end = t1;
            mark(state, (state.stage == 'form') ? 'form_view' : 'view',
                t0, t1);
        } else if (method == 'search') {
            // search: emission -> resolution (screen.js:1157-1159).
            // Never cached, hence the most reliable figure of the set.
            // Bounded on a jQuery .then(), which in jQuery 3 goes through
            // setTimeout: the hop-free transport window of the same call is
            // in bench_raw.csv, and the difference between the two IS the
            // scheduling hop.
            mark(state, 'search', t0, t1);
        }
    };

    var make_execute_wrapper = function(original, state, belongs) {
        return function() {
            if (!belongs(this)) {
                return original.apply(this, arguments);
            }
            var method = arguments[0];
            var t0 = now();
            state.watcher.note();
            var settle = function(asynchronous) {
                var t1 = now();
                state.watcher.note();
                mark_model_call(state, method, t0, t1, asynchronous);
            };
            var result;
            try {
                result = original.apply(this, arguments);
            } catch (error) {
                // Synchronous mode throws the deferred (rpc.js:199-203).
                settle(false);
                throw error;
            }
            if (result && (typeof result.always == 'function')) {
                result.always(function() {
                    settle(true);
                });
            } else {
                // Synchronous branch: the thread was frozen, and the interval
                // measured is that freeze.
                settle(false);
            }
            return result;
        };
    };

    var instrument_model = function(screen, state) {
        // screen.model is a Sao.Model built by Screen.init for this screen
        // only, so shadowing execute() on the instance touches nothing else in
        // the client -- hence no ownership test is needed here.
        var model = screen.model;
        model.execute = make_execute_wrapper(model.execute, state, always_true);
        return function() {
            delete model.execute;
        };
    };

    var make_tree_wrappers = function(state, originals, belongs) {
        return {
            construct: function() {
                if (!belongs(this.screen)) {
                    return originals.construct.apply(this, arguments);
                }
                state.construct_calls++;
                var result = originals.construct.apply(this, arguments);
                var t1 = now();
                // tree_construct: Screen.load -> end of construct
                // (tree.js:1215-1242).  DOM skeleton, pure client CPU, no RPC.
                // Gated on load_start so that the empty construct performed by
                // the initial switch_view -- before any record exists -- is
                // counted but not measured.
                if ((state.load_start !== null) &&
                        (state.construct_end === null)) {
                    state.construct_end = t1;
                    mark(state, 'tree_construct', state.load_start, t1);
                }
                state.tree = this;
                return result;
            },
            redraw: function() {
                if (!belongs(this.screen)) {
                    return originals.redraw.apply(this, arguments);
                }
                var measured = (state.construct_end !== null) &&
                    (state.redraw_end === null);
                state.redraw_calls++;
                var prm = originals.redraw.apply(this, arguments);
                if (prm && (typeof prm.always == 'function')) {
                    prm.always(function() {
                        var t1 = now();
                        state.watcher.note();
                        if (measured && (state.redraw_end === null)) {
                            state.redraw_end = t1;
                            // tree_display: end of construct -> resolution of
                            // redraw_async (tree.js:1750-1779).
                            mark(state, 'tree_display', state.construct_end,
                                t1);
                        }
                    });
                }
                return prm;
            },
            display: function() {
                if (!belongs(this.screen)) {
                    return originals.display.apply(this, arguments);
                }
                state.render_passes++;
                state.watcher.note();
                var prm = originals.display.apply(this, arguments);
                if (prm && (typeof prm.always == 'function')) {
                    prm.always(function() {
                        state.watcher.note();
                    });
                }
                return prm;
            }
        };
    };

    var instrument_view = function(view, state) {
        var original_display = view.display;
        view.display = function() {
            state.render_passes++;
            state.watcher.note();
            var prm = original_display.apply(this, arguments);
            if (prm && (typeof prm.always == 'function')) {
                prm.always(function() {
                    state.watcher.note();
                });
            }
            return prm;
        };
    };

    var instrument_tree = function(view, state) {
        var wrappers = make_tree_wrappers(state, {
            construct: view.construct,
            redraw: view.redraw,
            display: view.display
        }, always_true);
        view.construct = wrappers.construct;
        view.redraw = wrappers.redraw;
        view.display = wrappers.display;
    };

    var instrument_screen = function(screen, state) {
        var original_add_view = screen.add_view;
        var original_load = screen.load;
        var original_display = screen.display;
        screen.add_view = function() {
            var t0 = now();
            var widget = original_add_view.apply(this, arguments);
            var t1 = now();
            // view_build: end of fields_view_get -> end of add_view
            // (screen.js:944-997).  Pure client build, 100% synchronous, no
            // RPC of its own.  Anchored on the end of the RPC and not on the
            // entry into add_view, so that the jQuery scheduling hop between
            // the two is accounted for rather than swept under the carpet.
            var start = (state.view_rpc_end === null) ? t0 : state.view_rpc_end;
            mark(state, (state.stage == 'form') ? 'form_view_build' :
                'view_build', start, t1);
            state.view_rpc_end = null;
            if (widget) {
                if (widget.view_type == 'tree') {
                    instrument_tree(widget, state);
                } else {
                    instrument_view(widget, state);
                }
            }
            return widget;
        };
        screen.load = function() {
            state.load_start = now();
            state.watcher.note();
            return original_load.apply(this, arguments);
        };
        screen.display = function() {
            state.watcher.note();
            var prm = original_display.apply(this, arguments);
            if (prm && (typeof prm.always == 'function')) {
                prm.always(function() {
                    state.watcher.note();
                });
            }
            return prm;
        };
        return function() {
            delete screen.add_view;
            delete screen.load;
            delete screen.display;
        };
    };

    // Prototype level variant, used ONLY by the early validation gate to
    // measure a REAL tab: Sao.Tab.create resolves after the screen was already
    // built and search_filter already called, so there is no instance to hook
    // in time.  Scoped by model name and restored immediately afterwards.
    var instrument_prototypes = function(model_name, state) {
        var screen_proto = Sao.Screen.prototype;
        var tree_proto = Sao.View.Tree.prototype;
        var model_proto = Sao.Model.prototype;
        var original_load = screen_proto.load;
        var original_execute = model_proto.execute;
        var originals = {
            construct: tree_proto.construct,
            redraw: tree_proto.redraw,
            display: tree_proto.display
        };
        var belongs = function(screen) {
            return Boolean(screen) && (screen.model_name == model_name);
        };
        // Sao.Model carries the model name on the instance (model.js:42), so
        // the same scoping rule applies one level down.  Without this hook the
        // `search` phase is never marked on the tab arm -- Screen.load and the
        // Tree prototypes say nothing about it -- and the comparison gate came
        // back with search = null on one side, unable to compare the single
        // most WAF-sensitive phase of the whole plugin.
        var model_belongs = function(model) {
            return Boolean(model) && (model.name == model_name);
        };
        var wrappers = make_tree_wrappers(state, originals, belongs);
        screen_proto.load = function() {
            if (belongs(this)) {
                state.load_start = now();
                state.watcher.note();
            }
            return original_load.apply(this, arguments);
        };
        model_proto.execute = make_execute_wrapper(
            original_execute, state, model_belongs);
        tree_proto.construct = wrappers.construct;
        tree_proto.redraw = wrappers.redraw;
        tree_proto.display = wrappers.display;
        return function() {
            screen_proto.load = original_load;
            model_proto.execute = original_execute;
            tree_proto.construct = originals.construct;
            tree_proto.redraw = originals.redraw;
            tree_proto.display = originals.display;
        };
    };

    // ---- action resolution ----

    // The plan carries an XML identifier ("contract.act_contract_form").  The
    // GTK plugin resolves it with an ir.model.data.search_read at every single
    // iteration (plugins/bench/__init__.py:51-64).  That lookup is memoized
    // here and kept OUT of the measured `action` phase on purpose: a real menu
    // click already holds the numeric action id and never issues that
    // search_read, so charging it to `action` would inflate the phase against
    // the reality it is meant to represent.  The memo is deliberately NOT
    // cleared by the cold regime for the same reason.
    Driver.resolve_action_id = function(xml_id) {
        var known = action_ids[xml_id];
        if (known !== undefined) {
            return jQuery.when(known);
        }
        var parts = String(xml_id || '').split('.');
        var module = parts.shift();
        var fs_id = parts.join('.');
        if (!module || !fs_id) {
            return jQuery.Deferred().reject(Sao.i18n.gettext(
                'Benchmark: malformed action identifier "%1".',
                String(xml_id))).promise();
        }
        return new Sao.Model('ir.model.data').execute(
            'search_read',
            [[['module', '=', module], ['fs_id', '=', fs_id]],
                0, 1, null, ['db_id']],
            {}).then(function(found) {
                if (!found || !found.length) {
                    return jQuery.Deferred().reject(Sao.i18n.gettext(
                        'Benchmark: unknown action identifier "%1".',
                        String(xml_id))).promise();
                }
                action_ids[xml_id] = found[0].db_id;
                return found[0].db_id;
            });
    };

    Driver.clear_action_cache = function() {
        action_ids = {};
    };

    // Sao.Action.execute resolves a numeric id SYNCHRONOUSLY (action.js:204,
    // async=false): it freezes the main thread, and a frozen thread cannot be
    // timed honestly.  The same RPC is therefore re-issued here in async mode.
    // The server caches it one day client side (ir/action.py:81), so in the
    // warm regime this phase legitimately falls to ~0 ms from the second
    // iteration on, while in the cold regime the client cache was purged and
    // it is a real round trip.
    var get_action_value = function(action_id, context) {
        return new Sao.Model('ir.action').execute(
            'get_action_value', [action_id], context || {});
    };

    // Attribute dictionary of Sao.Screen, READ FROM action.js:62-118 -- the
    // `case 'ir.action.act_window'` branch of Sao.Action.exec_action -- and
    // not invented; inventing it is the stated first cause of failure of this
    // block.  Reproduced faithfully, minus the two parts that only mean
    // something for a visible tab: the `data` payload of a keyword action
    // (active_model / active_id / active_ids stay empty, because the plan
    // opens an action the way a menu does, not from a selected record), and
    // the trailing Sao.Tab.create(params) -- the one call not to make.
    Driver.act_window_attributes = function(action, context) {
        var session = Sao.Session.current_session;
        var params = {
            'icon': action['icon.rec_name'] || ''
        };
        if (!jQuery.isEmptyObject(action.views)) {
            params.view_ids = [];
            params.mode = [];
            action.views.forEach(function(view) {
                params.view_ids.push(view[0]);
                params.mode.push(view[1]);
            });
        } else if (!jQuery.isEmptyObject(action.view_id)) {
            params.view_ids = [action.view_id[0]];
        }
        if (action.pyson_domain === undefined) {
            action.pyson_domain = '[]';
        }
        var ctx = {
            active_model: null,
            active_id: null,
            active_ids: []
        };
        ctx = jQuery.extend(ctx, session.context);
        ctx._user = session.user_id;
        var decoder = new Sao.PYSON.Decoder(ctx);
        params.context = jQuery.extend(
            {}, context || {}, decoder.decode(action.pyson_context || '{}'));
        ctx = jQuery.extend(ctx, params.context);
        ctx.context = Sao.common.clone(ctx);
        decoder = new Sao.PYSON.Decoder(ctx);
        params.domain = decoder.decode(action.pyson_domain);
        params.order = decoder.decode(action.pyson_order);
        params.search_value = decoder.decode(action.pyson_search_value || '[]');
        params.tab_domain = [];
        (action.domains || []).forEach(function(element) {
            params.tab_domain.push(
                [element[0], decoder.decode(element[1]), element[2]]);
        });
        params.model = action.res_model;
        params.res_id = action.res_id;
        params.context_model = action.context_model;
        params.show_filter = action.show_filter;
        params.context_domain = action.context_domain;
        params.window_name_field = action.window_name_field;
        if ((action.limit !== undefined) && (action.limit !== null)) {
            params.limit = action.limit;
        }
        params.name = action.name;
        return params;
    };

    // ---- cold regime ----

    // Purges what does not purge itself.  What CANNOT be purged from here is
    // documented rather than pretended away:
    //   - Record._loaded (model.js:666-682) is immune to cache.clear(); only a
    //     fresh Group/Screen clears it, and the driver builds one per
    //     iteration.
    //   - Row._drawed_record (tree.js:1981, set :2050) short circuits the
    //     entire cell render loop; it dies with the rows of the discarded
    //     Screen.
    //   - Screen.views_preload (screen.js:926-929) is purely client side and
    //     cache.clear() does not reach it; the driver never passes one, so
    //     each Screen starts empty.
    //   - the domain parser memo (screen.js:1936, :1941) belongs to the Screen
    //     and goes away with it.
    Driver.purge_caches = function() {
        var session = Sao.Session.current_session;
        if (session && session.cache) {
            session.cache.clear();
        }
    };

    // ---- runners ----

    var describe_error = function(error) {
        if (!error) {
            return Sao.i18n.gettext('unknown error');
        }
        if (typeof error == 'string') {
            return error;
        }
        if (error instanceof Array) {
            return error.join(': ');
        }
        if (error.message) {
            return String(error.message);
        }
        return String(error);
    };

    // bench.py times with timeit.default_timer, that is SECONDS, while every
    // CSV time column is in milliseconds.
    var server_aggregates = function(result) {
        if (!result || (typeof result != 'object')) {
            return null;
        }
        var to_ms = function(value) {
            return (typeof value == 'number') ? value * 1000 : null;
        };
        return {
            iterations: result.iterations,
            average: to_ms(result.average),
            minimum: to_ms(result.minimum),
            maximum: to_ms(result.maximum),
            slowest: to_ms(result.slowest)
        };
    };

    var run_latency = function(entry, options, result) {
        var t0 = now();
        // Reference probe: test_latency has an EMPTY body (bench.py:152-154),
        // so this is the cleanest available measurement of the fixed cost of
        // one round trip -- precisely the quantity a WAF inflates.
        return new Sao.Model('bench').execute('test_latency', [], {})
            .then(function() {
                emit_phase(result.phases, 'latency', t0, now());
                return result;
            });
    };

    var run_server = function(entry, options, result) {
        var method = (entry.parameters || {}).method;
        if (!method) {
            return jQuery.Deferred().reject(Sao.i18n.gettext(
                'Benchmark: server entry without a method.')).promise();
        }
        var t0 = now();
        return new Sao.Model('bench').execute(method, [], {})
            .then(function(server_result) {
                var srv = server_aggregates(server_result);
                // The server hands back a dict ALREADY aggregated by its own
                // do_bench (bench.py:18-41), whose aggregation is broken:
                // double truncation, and `minimum` / `maximum` index a list
                // that was already trimmed, so `maximum` is in fact the second
                // largest value.  The latency tail -- the only reliable signal
                // of a WAF -- is erased.  Reported as-is under srv_* for
                // traceability, never as a conclusion; the wall-to-wall RTT
                // measured on this side is the usable figure.
                emit_phase(result.phases, 'server', t0, now(), undefined,
                    {srv: srv});
                result.info.srv = srv;
                return result;
            });
    };

    var collect_act_window_info = function(screen, state, result, sample_index) {
        var tree = state.tree;
        var info = result.info;
        info.rows = tree ? tree.rows.length : null;
        info.display_size = tree ? tree.display_size : null;
        info.group_length = screen ? screen.group.length : null;
        info.search_count = screen ? screen.search_count : null;
        info.limit = screen ? screen.limit : null;
        info.view_type = (screen && screen.current_view) ?
            screen.current_view.view_type : null;
        info.render_passes = state.render_passes;
        info.construct_calls = state.construct_calls;
        info.redraw_calls = state.redraw_calls;
        info.repeats = {};
        for (var phase in state.marks) {
            if (Object.prototype.hasOwnProperty.call(state.marks, phase)) {
                info.repeats[phase] = state.marks[phase].repeats;
            }
        }
        info.rpc_calls = rpc_breakdown(sample_index);
        return info;
    };

    // A search that matches nothing renders nothing: Tree.display never calls
    // construct() on an empty group (tree.js:1019-1037 -- all three branches
    // compare min_display_size to rows.length, both 0), so no read is issued
    // and tree_construct / tree_display are never marked.
    //
    // Emitting NOTHING for them would be the wrong kind of silence.  On a WAF
    // comparison an absent phase reads as "nothing to see" rather than "not
    // measured", and an aggregate row that exists in one campaign and not in
    // the other is an asymmetry nobody notices.  So the phase is emitted with
    // an EMPTY duration and an explicit cause -- the same rule the percentiles
    // already follow (below their threshold they are an empty cell, never a 0)
    // and the same rule the Probe follows for a call that never reached the
    // wire.  Csv.aggregate then shows the phase with n = 0 and n_invalid = 1:
    // present, and visibly unmeasured.
    var EMPTY_RENDER_PHASES = ['tree_construct', 'tree_display',
        'tree_display_net'];

    var emit_empty_render_markers = function(screen, state, result) {
        if (!screen || (screen.group.length !== 0)) {
            return;
        }
        result.info.empty_result_set = true;
        var t = now();
        EMPTY_RENDER_PHASES.forEach(function(phase) {
            if (state.marks[phase] || (result.phases[phase] !== undefined)) {
                return;
            }
            result.phases[phase] = null;
            Probe.add_phase_sample({
                phase: phase,
                t_start_ms: Probe.elapsed(t),
                t_end_ms: Probe.elapsed(t),
                duration_ms: null,
                causes: ['empty_result_set']
            });
        });
    };

    var run_act_window = function(entry, options, result) {
        var params = entry.parameters || {};
        var width = options.container_width || Driver.CONTAINER_WIDTH;
        var height = options.container_height || Driver.CONTAINER_HEIGHT;
        var watcher = make_watcher();
        var state = new_state(watcher);
        var sample_index = Probe.samples.length;
        var t_total = now();
        var focus_before = document.activeElement;
        var undo = [];
        var container = null;
        var screen = null;

        // The container dimensions decide how many rows the tree builds
        // (offsetHeight read), whereas the fields_view_get cache key carries
        // context.screen_size = the BROWSER window (screen.js:930-936).  Two
        // distinct effects, recorded under two distinct columns: merging them
        // would let a campaign run in a resized window be compared to another.
        result.info.container_width = width;
        result.info.container_height = height;
        result.info.window_width = window.innerWidth;
        result.info.window_height = window.innerHeight;
        result.info.viewport_width = window.visualViewport ?
            window.visualViewport.width : null;
        result.info.viewport_height = window.visualViewport ?
            window.visualViewport.height : null;
        // Sao.Tab.set_view_type and Tab.refresh_name are reached through
        // switch_view (screen.js:1062, :1081) and read the CURRENT visible
        // tab, not our screen: harmless, but a tab left open can in principle
        // slip an extra read into the campaign, so its presence is recorded.
        result.info.visible_tab_open = Boolean(Sao.Tab.tabs.get_current());

        var teardown = function() {
            undo.forEach(function(restore) {
                try {
                    restore();
                } catch (error) {
                    log_failure('driver teardown failed', error);
                }
            });
            undo = [];
            // Removes the container AND releases the "More" observer targets
            // it holds, in that order.
            drop_container(container);
            container = null;
            // search_filter focuses the search entry (screen.js:1188): give
            // the focus back so that normal navigation is untouched.
            if (focus_before && (typeof focus_before.focus == 'function') &&
                    document.contains(focus_before)) {
                focus_before.focus();
            }
        };

        var run_form_stage = function() {
            if (!params.switch_view) {
                return jQuery.when();
            }
            state.stage = 'form';
            var t0 = now();
            // form_display is an HONEST bound: switch_view really awaits
            // Form.display (screen.js:1071-1077), unlike Screen.display() on
            // the tree side.  form_view / form_view_build are emitted by the
            // same hooks and are NESTED inside it -- they are a breakdown of
            // form_display, not an addition to it.
            return screen.switch_view('form').then(function() {
                mark(state, 'form_display', t0, now());
                // The double rAF is issued HERE, right at the end of the
                // phase, and not after the settle window: waited for after
                // quiescence it would time an idle frame instead of the frame
                // that follows the render.
                return next_paint();
            }).then(function(paint) {
                emit_phase(result.phases, 'form_paint',
                    paint.t_start, paint.t_end);
                result.info.form_paint_observed = paint.observed;
                return wait_quiet(watcher);
            }).then(function(quiet) {
                result.info.form_quiescence_timed_out = quiet.timed_out;
            });
        };

        return Driver.resolve_action_id(params.action_id)
            .then(function(action_db_id) {
                // The clock starts after the memoized XML id lookup, which a
                // real menu click never performs: including it would make the
                // first iteration of a campaign structurally slower than the
                // others for a reason that has nothing to do with the screen.
                var t0 = now();
                t_total = t0;
                return get_action_value(action_db_id).then(function(action) {
                    mark(state, 'action', t0, now());
                    return action;
                });
            })
            .then(function(action) {
                if (!action || (action.type != 'ir.action.act_window')) {
                    return jQuery.Deferred().reject(Sao.i18n.gettext(
                        'Benchmark: action "%1" is not an act_window.',
                        String(params.action_id))).promise();
                }
                var attributes = Driver.act_window_attributes(action);
                if (attributes.res_id) {
                    // An act_window carrying a res_id opens on records, not on
                    // a search: Sao.Tab.Form drops tab_domain and calls
                    // screen.load(res_id) instead of search_filter
                    // (tab.js:580-590).  None of the eight declared plan
                    // entries does, and replaying it as a search would produce
                    // a figure that measures something else.  Refused rather
                    // than approximated.
                    return jQuery.Deferred().reject(Sao.i18n.gettext(
                        'Benchmark: action "%1" opens on a record (res_id);' +
                        ' only list actions can be replayed.',
                        String(params.action_id))).promise();
                }
                result.info.model = attributes.model;
                result.info.mode = (attributes.mode || []).join(',');
                container = new_container(width, height);
                screen = new Sao.Screen(attributes.model, attributes);
                // screen.windows stays EMPTY on purpose: every consumer is
                // guarded, either by `window_ instanceof Sao.Tab.Form`
                // (screen.js:817, :966) or by a method presence test
                // (screen.js:1345-1398).  Faking a window object buys nothing
                // and breaks things for free.
                undo.push(instrument_model(screen, state));
                undo.push(instrument_screen(screen, state));
                return screen.switch_view();
            })
            .then(function() {
                // Same order as Sao.Tab.Form.init (tab.js:574-596): the
                // container receives the screen once the first view is loaded,
                // and only then is the search fired.
                container.append(screen.screen_container.el);
                return screen.search_filter();
            })
            .then(function() {
                return next_paint();
            })
            .then(function(paint) {
                emit_marks(state, result.phases, [
                    'action', 'view', 'view_build', 'search',
                    'tree_construct', 'tree_display']);
                if (state.marks.tree_display) {
                    var m = state.marks.tree_display;
                    var busy = rpc_busy_between(
                        m.t_start, m.t_end, sample_index);
                    emit_phase(result.phases, 'tree_display_net',
                        m.t_start, m.t_end, m.t_end - m.t_start - busy);
                    result.info.tree_display_rpc_ms = busy;
                }
                emit_empty_render_markers(screen, state, result);
                emit_phase(result.phases, 'paint',
                    paint.t_start, paint.t_end);
                result.info.paint_observed = paint.observed;
                return wait_quiet(watcher);
            })
            .then(function(quiet) {
                result.info.list_quiescence_timed_out = quiet.timed_out;
                return run_form_stage();
            })
            .then(function() {
                emit_marks(state, result.phases, [
                    'form_view', 'form_view_build', 'form_display']);
                collect_act_window_info(screen, state, result, sample_index);
                // The iteration ends on the LAST activity observed, not at the
                // far end of the settle window: the settle is instrument time,
                // charging it to the scenario would add a constant SETTLE_MS
                // to every total.
                emit_phase(result.phases, 'total', t_total,
                    Math.max(watcher.last_activity, t_total));
                teardown();
                return result;
            }, function(error) {
                // A scenario killed mid flight -- a WAF guard delay, a 504 --
                // is a result, not a crash: whatever phases did complete are
                // emitted before giving the failure back to the caller.
                emit_marks(state, result.phases, [
                    'action', 'view', 'view_build', 'search',
                    'tree_construct', 'tree_display', 'form_view',
                    'form_view_build', 'form_display']);
                collect_act_window_info(screen, state, result, sample_index);
                teardown();
                return jQuery.Deferred().reject(error).promise();
            });
    };

    var RUNNERS = {
        'latency': run_latency,
        'server': run_server,
        'act_window': run_act_window
    };

    // ---- public entry points ----

    Driver.run = function(entry, options) {
        entry = entry || {};
        options = options || {};
        var scenario = options.scenario || entry.name || entry.type || '';
        var own_install = Driver.install();
        var result = {
            scenario: scenario,
            type: entry.type || '',
            regime: options.regime || '',
            iteration: (options.iteration === undefined) ?
                '' : options.iteration,
            warmup: Boolean(options.warmup),
            ok: false,
            error: '',
            phases: {},
            info: {}
        };
        // Every RPC emitted from here on carries this context, so the raw CSV
        // rows of the iteration and its phase rows aggregate together.
        Probe.set_context({
            scenario: scenario,
            iteration: result.iteration,
            regime: result.regime,
            warmup: result.warmup
        });
        // Without the probe the in-flight counters stay at zero and the
        // quiescence detector degrades into a plain timer: still measurable,
        // no longer trustworthy.  Recorded instead of hidden.
        result.info.probe_installed = Probe.installed;
        var runner = RUNNERS[entry.type];
        var prm;
        if (!runner) {
            prm = jQuery.Deferred().reject(Sao.i18n.gettext(
                'Benchmark: unknown plan entry type "%1".',
                String(entry.type))).promise();
        } else {
            if (options.regime == 'cold') {
                Driver.purge_caches();
            }
            try {
                prm = runner(entry, options, result);
            } catch (error) {
                prm = jQuery.Deferred().reject(error).promise();
            }
        }
        return prm.then(function() {
            result.ok = true;
        }, function(error) {
            result.ok = false;
            result.error = describe_error(error);
            return jQuery.when();
        }).then(function() {
            if (own_install) {
                Driver.uninstall();
            }
            return Driver.gap(options.gap_ms);
        }).then(function() {
            return result;
        });
    };

    // Replays the SAME entry n times in a row.  Thin on purpose: the campaign
    // -- plan, warmup, setup/teardown, progress, cooperative abort -- belongs
    // to the Runner.  This exists so that the two validations this task owns
    // are a one-liner from the console: two successive cold iterations must
    // stay in the same range (no upward drift, which proves the isolation and
    // the teardown work), and under artificial network latency `search` must
    // grow while `tree_construct` must not.
    Driver.repeat = function(entry, options, count) {
        options = options || {};
        var results = [];
        var total = count || 2;
        var own_install = Driver.install();
        var step = function(index) {
            if (index >= total) {
                return jQuery.when(results);
            }
            return Driver.run(entry, jQuery.extend({}, options, {
                iteration: index
            })).then(function(result) {
                results.push(result);
                return step(index + 1);
            });
        };
        return step(0).always(function() {
            if (own_install) {
                Driver.uninstall();
            }
        });
    };

    // ---- early validation gate (risk 1) ----

    var measure_tab = function(entry, options, result) {
        var params = entry.parameters || {};
        var watcher = make_watcher();
        var state = new_state(watcher);
        var sample_index = Probe.samples.length;
        var undo = null;
        var tab = null;

        var teardown = function() {
            if (undo) {
                try {
                    undo();
                } catch (error) {
                    log_failure('prototype teardown failed', error);
                }
                undo = null;
            }
        };

        return Driver.resolve_action_id(params.action_id)
            .then(function(action_db_id) {
                return get_action_value(action_db_id).then(function(action) {
                    return {id: action_db_id, action: action};
                });
            })
            .then(function(resolved) {
                result.info.model = resolved.action.res_model;
                undo = instrument_prototypes(resolved.action.res_model, state);
                // Sao.Action.execute resolves a numeric id synchronously
                // (action.js:204), so the `action` phase is NOT measurable on
                // this arm and is deliberately absent from its phases.  The
                // action value was just fetched, so the server marked it
                // cacheable and the synchronous call is a client cache hit
                // (rpc.js:14-25) rather than a frozen round trip.
                // The third argument MUST be passed explicitly, even as null
                // (same as sao.js:430).  Left undefined, args.params is
                // [id, undefined], and jQuery.extend drops a trailing
                // undefined while copying the array (rpc.js:12): the pop()
                // of rpc.js:13 then removes the ACTION ID instead of the
                // context, the server is called with no id, answers null and
                // exec_action throws on action.id.
                return Sao.Action.execute(resolved.id, {}, null);
            })
            .then(function(created) {
                tab = created;
                return wait_quiet(watcher);
            })
            .then(function(quiet) {
                result.info.list_quiescence_timed_out = quiet.timed_out;
                // No paint phase on this arm: Sao.Tab.create resolves before
                // any data is loaded, so the only end signal available here is
                // quiescence, and a rAF issued after the settle window would
                // time an idle frame.  Comparing it to the detached paint --
                // which IS issued at the end of the render -- would be
                // comparing two different quantities.
                emit_marks(state, result.phases,
                    ['search', 'tree_construct', 'tree_display']);
                var screen = tab ? tab.screen : null;
                collect_act_window_info(screen, state, result, sample_index);
                teardown();
                if (tab && !options.keep_tab) {
                    return tab.close();
                }
                return jQuery.when();
            })
            .then(function() {
                result.ok = true;
                return result;
            }, function(error) {
                teardown();
                result.ok = false;
                result.error = describe_error(error);
                return jQuery.when(result);
            });
    };

    // Early validation gate of risk 1, to run on ONE target -- typically
    // contract.act_contract_form, tree-only variant -- BEFORE wiring the eight
    // act_window scenarios.  Replays the entry detached, then opens the SAME
    // action in a real tab and measures the same bounds, so that the figures
    // which decide whether the detached driver represents a real display can
    // be put side by side: row count, number and nature of the RPCs, search,
    // tree_construct.  A structural gap -- a missing RPC, a row count off by
    // an order of magnitude -- means stopping and reporting, not
    // industrializing a measurement that represents nothing.
    Driver.compare_act_window = function(entry, options) {
        entry = entry || {};
        options = options || {};
        var own_install = Driver.install();
        var name = entry.name || (entry.parameters || {}).action_id || '';
        var report = {
            scenario: name,
            detached: null,
            tab: null,
            delta: {}
        };
        return Driver.run(entry, jQuery.extend({}, options, {
            scenario: name + ' [detached]'
        })).then(function(detached) {
            report.detached = detached;
            return Driver.gap(options.gap_ms);
        }).then(function() {
            var tab_result = {
                scenario: name + ' [tab]',
                type: entry.type || '',
                regime: options.regime || '',
                iteration: (options.iteration === undefined) ?
                    '' : options.iteration,
                warmup: Boolean(options.warmup),
                ok: false,
                error: '',
                phases: {},
                info: {}
            };
            Probe.set_context({
                scenario: tab_result.scenario,
                iteration: tab_result.iteration,
                regime: tab_result.regime,
                warmup: tab_result.warmup
            });
            if (options.regime == 'cold') {
                Driver.purge_caches();
            }
            return measure_tab(entry, options, tab_result);
        }).then(function(tab_result) {
            report.tab = tab_result;
            report.delta = Driver.compare_arms(report.detached, tab_result);
            return report;
        }).always(function() {
            if (own_install) {
                Driver.uninstall();
            }
        });
    };

    Driver.compare_arms = function(detached, tab) {
        var delta = {phases: {}, info: {}};
        var left = detached || {phases: {}, info: {}};
        var right = tab || {phases: {}, info: {}};
        ['search', 'tree_construct', 'tree_display'].forEach(
            function(phase) {
                delta.phases[phase] = {
                    detached: (left.phases[phase] === undefined) ?
                        null : left.phases[phase],
                    tab: (right.phases[phase] === undefined) ?
                        null : right.phases[phase]
                };
            });
        ['rows', 'group_length', 'display_size', 'search_count',
            'render_passes', 'construct_calls', 'redraw_calls',
            'rpc_calls'].forEach(function(key) {
                delta.info[key] = {
                    detached: (left.info[key] === undefined) ?
                        null : left.info[key],
                    tab: (right.info[key] === undefined) ?
                        null : right.info[key]
                };
            });
        return delta;
    };
    // ================================================================
    // Runner -- campaign orchestration.
    // ================================================================

    var Runner = {};
    Sao.Benchmark.Runner = Runner;

    Runner.DEFAULT_ITERATIONS = 10;
    // The K first iterations are MEASURED and MARKED, then excluded from the
    // aggregates -- never silently dropped.  They stay in bench_raw.csv and K
    // is written to bench_meta.csv, so a reader can recompute with or without
    // them.
    Runner.DEFAULT_WARMUP = 5;
    // cold purges the client caches before every iteration -- the regime that
    // actually exercises the WAF -- while warm is the real user experience.
    // Reported SEPARATELY, never merged into one percentile: the distribution
    // is bimodal and a merged p90 would describe neither.
    Runner.REGIMES = ['cold', 'warm'];
    Runner.ARMS = ['direct', 'waf'];
    // Grace period left to the asynchronous resource timing entries before
    // the campaign is finalized.
    Runner.FINISH_GRACE_MS = 250;

    // Risk 10: two dialogs open must not start two campaigns fighting over
    // the same benchmark_table.  Module level on purpose, so the guard is
    // shared by every dialog of the tab AND by a console call.
    var running = false;

    Runner.is_running = function() {
        return running;
    };

    var log_runner_failure = function(message, error) {
        Sao.Logger.error('Sao.Benchmark.Runner: ' + message, error);
    };

    var reject_message = function(message) {
        return jQuery.Deferred().reject(message).promise();
    };

    // trytond serializes a plain exception as (str(exception), traceback)
    // (jsonrpc.py:210-215): the readable part is the first element, the
    // second is a full Python traceback that has no place in a dialog.
    var server_error_text = function(error) {
        if (error instanceof Array) {
            return String((error[0] === undefined) ? '' : error[0]);
        }
        if ((error === undefined) || (error === null) || (error === '')) {
            // process_exception=false rejects with NO argument on a transport
            // failure (rpc.js:161-164): saying so beats inventing a cause.
            return Sao.i18n.gettext(
                'no server response (request cut short or connection lost)');
        }
        return describe_error(error);
    };

    // ---- message bus ----

    // /bus is a DISTINCT route (trytond/bus.py:221) which does not go through
    // _dispatch: a long poll appears in no server log line at all while it
    // pins a worker for its whole duration.  No server side check can ever
    // confirm it was stopped, so the client side statement recorded in
    // bench_meta.csv is the only evidence available -- and it conditions the
    // validity of the positional join with the server log.
    var bus_original_listen = null;
    var bus_blocked_relisten = 0;
    var bus_aborted_request = null;
    var bus_was_listening = false;

    var stop_bus = function() {
        if (!Sao.Bus) {
            return 'no_bus_client';
        }
        bus_was_listening = Boolean(Sao.Bus.listening) ||
            Boolean(Sao.Bus.request);
        bus_blocked_relisten = 0;
        if (!bus_original_listen) {
            bus_original_listen = Sao.Bus.listen;
            // Aborting alone does NOT stop the bus: the fail handler re-arms
            // on "abort" (bus.js:56-58) and the done handler re-arms on every
            // completed poll (bus.js:50).  Both read Sao.Bus.listen through
            // the live binding, so a no-op stub does stop it.
            Sao.Bus.listen = function() {
                bus_blocked_relisten++;
            };
        }
        bus_aborted_request = Sao.Bus.request || null;
        if (Sao.Bus.request) {
            Sao.Bus.request.abort();
        }
        Sao.Bus.listening = false;
        return bus_was_listening ? 'stopped' : 'not_listening';
    };

    var bus_attestation = function(base) {
        // Semicolon separated tokens, machine readable, written to the
        // bus_stopped column.  The `restarted` token is not decoration: an
        // error backoff timer scheduled BEFORE the stub was installed carries
        // the ORIGINAL function by reference (bus.js:68-71) and cannot be
        // intercepted.  Detected here rather than assumed away.
        var tokens = [base || ''];
        if (bus_blocked_relisten) {
            tokens.push('blocked=' + bus_blocked_relisten);
        }
        if (Sao.Bus && Sao.Bus.request &&
                (Sao.Bus.request !== bus_aborted_request)) {
            tokens.push('restarted');
        }
        return tokens.join(';');
    };

    var restore_bus = function() {
        if (!Sao.Bus) {
            return;
        }
        if (bus_original_listen) {
            Sao.Bus.listen = bus_original_listen;
            bus_original_listen = null;
        }
        if (bus_was_listening) {
            Sao.Bus.listen();
        }
        bus_was_listening = false;
        bus_aborted_request = null;
    };

    // ---- activation guard and plan ----

    var call_bench = function(method) {
        // process_exception=false: a bench failure must surface as our own
        // explicit message, never as a raw Tryton error dialog carrying a
        // Python traceback (rpc.js:107).
        return new Sao.Model('bench').execute(method, [], {}, true, false);
    };

    Runner.check_module = function() {
        // Same guard as the GTK plugin (plugins/bench/__init__.py:90-101).
        // On a database without the module the search simply comes back
        // empty: an explicit message, NO measurement, no technical error and
        // no console trace (functional criterion 1).
        if (!Sao.Session.current_session) {
            return reject_message(Sao.i18n.gettext(
                'Benchmark: no open session. Log in before running a' +
                ' campaign.'));
        }
        return new Sao.Model('ir.module').execute(
            'search',
            [[['name', '=', 'bench'], ['state', '=', 'activated']], 0, 1,
                null],
            {}, true, false
        ).then(function(found) {
            return Boolean(found && found.length);
        }, function(error) {
            return reject_message(Sao.i18n.gettext(
                'Benchmark: unable to check whether the bench module is' +
                ' activated: %1', server_error_text(error)));
        });
    };

    Runner.MODULE_MISSING_MESSAGE = function() {
        return Sao.i18n.gettext(
            'Benchmark: the "bench" module is not activated on this' +
            ' database. Activate it to run a campaign; nothing was measured.');
    };

    Runner.normalize_plan = function(plan) {
        // bench.list() (bench.py:63-122) hands back the NAMES of the setup
        // and teardown methods plus the method list, which the business
        // modules extend (contract 2 entries, claim 2, party_cog 4, on top of
        // the 6 declared by bench itself).  Nothing is fabricated here: a
        // database without `claim` simply has no claim entry, and no empty
        // row is emitted for it (functional criterion 3).
        plan = plan || {};
        var methods = plan.methods || [];
        var seen = {};
        var entries = methods.map(function(method, index) {
            method = method || {};
            var name = method.name || method.type || 'entry';
            var label = name;
            // The label is an aggregation key: two entries sharing a name
            // would silently merge their samples.
            if (seen[label]) {
                label = name + ' #' + index;
            }
            seen[label] = true;
            return {
                index: index,
                key: String(index),
                label: label,
                name: name,
                type: method.type || '',
                parameters: method.parameters || {},
                // Only test_db_read and test_db_write need the technical
                // table, and they are the two destructive scenarios.
                needs_setup: Boolean(method.setup)
            };
        });
        return {
            setup: plan.setup || 'setup',
            teardown: plan.teardown || 'teardown',
            entries: entries
        };
    };

    Runner.load_plan = function() {
        return Runner.check_module().then(function(activated) {
            if (!activated) {
                return {
                    activated: false,
                    setup: '',
                    teardown: '',
                    entries: [],
                    message: Runner.MODULE_MISSING_MESSAGE()
                };
            }
            return call_bench('list').then(function(plan) {
                var normalized = Runner.normalize_plan(plan);
                normalized.activated = true;
                normalized.message = '';
                return normalized;
            }, function(error) {
                return reject_message(Sao.i18n.gettext(
                    'Benchmark: unable to read the benchmark plan: %1',
                    server_error_text(error)));
            });
        });
    };

    var fetch_server_version = function() {
        // Read BEFORE the probe is installed: Sao.Session.server_version()
        // posts to rpc/#common.server.version (session.js:183-202), a URL the
        // probe matches, so it would consume a seq and be counted as a
        // campaign call.
        try {
            return Sao.Session.server_version().then(function(version) {
                return String(version || '');
            }, function() {
                return '';
            });
        } catch (error) {
            log_runner_failure('server version unavailable', error);
            return jQuery.when('');
        }
    };

    // ---- setup, and recovery of a residual table ----

    Runner.SETUP_BACKEND = 'backend';
    Runner.SETUP_RESIDUAL = 'residual_table';
    Runner.SETUP_UNKNOWN = 'unknown';

    var BACKEND_ERROR_RE = /postgresql/i;
    var RESIDUAL_ERROR_RE = /already in|benchmark[ _]table/i;

    Runner.classify_setup_error = function(error) {
        var text = server_error_text(error);
        // Backend first: 'Database must be postgresql !' (bench.py:128-129)
        // carries neither of the residual markers, but testing in this order
        // keeps the two branches independent of the exact wording.
        if (BACKEND_ERROR_RE.test(text)) {
            return Runner.SETUP_BACKEND;
        }
        if (RESIDUAL_ERROR_RE.test(text)) {
            return Runner.SETUP_RESIDUAL;
        }
        return Runner.SETUP_UNKNOWN;
    };

    Runner.recovery_message = function(error) {
        return [
            Sao.i18n.gettext(
                'A "benchmark_table" is left over from a previous run: the' +
                ' server refuses to set up a new campaign while it is there,' +
                ' so every future campaign is blocked until it is removed.'),
            Sao.i18n.gettext(
                'Recovery runs the teardown step of the benchmark module,' +
                ' which DROPS that table. It is a purely technical table' +
                ' created by the setup step and holds no business data, but' +
                ' the drop is irreversible.'),
            Sao.i18n.gettext(
                'The server said: "%1".', server_error_text(error))
        ];
    };

    var run_setup = function(plan, hooks) {
        // Resolves {done, recovered}; rejects with a message ready to be
        // displayed.
        return call_bench(plan.setup).then(function() {
            return {done: true, recovered: false};
        }, function(error) {
            var kind = Runner.classify_setup_error(error);
            if (kind == Runner.SETUP_BACKEND) {
                return reject_message(Sao.i18n.gettext(
                    'Benchmark: the setup step needs a PostgreSQL backend' +
                    ' and the server refused it: "%1". The scenarios that' +
                    ' need the technical table cannot run on this database.',
                    server_error_text(error)));
            }
            if (kind != Runner.SETUP_RESIDUAL) {
                return reject_message(Sao.i18n.gettext(
                    'Benchmark: the setup step failed: "%1".',
                    server_error_text(error)));
            }
            if (typeof hooks.confirm_recovery != 'function') {
                // NEVER automatic.  A caller with no way to ask the operator
                // gets the diagnosis and stops there.
                return reject_message(Sao.i18n.gettext(
                    'Benchmark: a "benchmark_table" is left over from a' +
                    ' previous run and the setup step refuses to run. The' +
                    ' recovery DROPS that table and must be confirmed by the' +
                    ' operator: start the campaign from the benchmark dialog' +
                    ' to confirm it. The server said: "%1".',
                    server_error_text(error)));
            }
            return jQuery.when(
                hooks.confirm_recovery(Runner.recovery_message(error))
            ).then(function(agreed) {
                if (agreed === false) {
                    return reject_message(Sao.i18n.gettext(
                        'Benchmark: recovery refused, the campaign was not' +
                        ' started.'));
                }
                return call_bench(plan.teardown).then(function() {
                    return call_bench(plan.setup);
                }).then(function() {
                    return {done: true, recovered: true};
                }, function(second) {
                    return reject_message(Sao.i18n.gettext(
                        'Benchmark: the recovery failed, the campaign was' +
                        ' not started: "%1".', server_error_text(second)));
                });
            }, function() {
                return reject_message(Sao.i18n.gettext(
                    'Benchmark: recovery refused, the campaign was not' +
                    ' started.'));
            });
        });
    };

    // ---- campaign plan ----

    var positive_int = function(value, fallback, minimum) {
        var number = parseInt(value, 10);
        if (isNaN(number) || (number < minimum)) {
            return fallback;
        }
        return number;
    };

    Runner.normalize_config = function(config) {
        config = config || {};
        var plan = config.plan || {};
        var entries = config.entries || plan.entries || [];
        var regimes = config.regimes;
        if (!regimes || !regimes.length) {
            regimes = Runner.REGIMES.slice();
        }
        return {
            plan: {
                setup: plan.setup || 'setup',
                teardown: plan.teardown || 'teardown'
            },
            entries: entries.slice(),
            iterations: positive_int(
                config.iterations, Runner.DEFAULT_ITERATIONS, 1),
            warmup: positive_int(config.warmup, Runner.DEFAULT_WARMUP, 0),
            regimes: regimes.slice(),
            arm: config.arm || '',
            notes: config.notes || '',
            container_width: config.container_width || Driver.CONTAINER_WIDTH,
            container_height: config.container_height ||
                Driver.CONTAINER_HEIGHT,
            available: config.available || entries.length
        };
    };

    Runner.build_steps = function(config) {
        var steps = [];
        config.regimes.forEach(function(regime) {
            var total = config.warmup + config.iterations;
            for (var i = 0; i < total; i++) {
                // Iteration major: every selected entry is replayed once
                // before the next iteration starts, so each scenario's
                // samples are spread over the whole campaign window.  Entry
                // major would confound a drift in server load with the entry
                // itself, which is exactly the confusion a WAF comparison
                // must avoid.
                config.entries.forEach(function(entry) {
                    steps.push({
                        entry: entry,
                        regime: regime,
                        iteration: i,
                        warmup: i < config.warmup
                    });
                });
            }
        });
        return steps;
    };

    // ---- campaign ----

    Runner.run_campaign = function(config, hooks) {
        hooks = hooks || {};
        config = Runner.normalize_config(config);
        if (running) {
            return reject_message(Sao.i18n.gettext(
                'Benchmark: a campaign is already running. Only one campaign' +
                ' can run at a time, two of them would fight over the same' +
                ' benchmark table.'));
        }
        if (!config.entries.length) {
            return reject_message(Sao.i18n.gettext(
                'Benchmark: no scenario selected, nothing to measure.'));
        }
        running = true;

        var state = {
            steps: Runner.build_steps(config),
            results: [],
            done: 0,
            failures: 0,
            aborted: false,
            setup_recovered: false,
            visibility_lost: false,
            teardown_error: '',
            server_version: ''
        };
        var owns_probe = false;
        var owns_driver = false;
        var setup_done = false;
        var bus_state = '';
        var info = null;

        var on_visibility = function() {
            if (!document.hidden) {
                return;
            }
            // A hidden tab throttles setTimeout to 1 Hz, and the jQuery
            // .then() chain IS setTimeout based (jquery.js:3602): the whole
            // internal chaining of Sao collapses, not just the instrument.
            // The operator is warned and the fact is written to the metadata.
            state.visibility_lost = true;
            if (typeof hooks.warn == 'function') {
                try {
                    hooks.warn(Sao.i18n.gettext(
                        'Benchmark: this tab went to the background during' +
                        ' the campaign. A background tab throttles the' +
                        ' browser timers, so the measurements taken from' +
                        ' that point on are not comparable. The fact is' +
                        ' recorded in the campaign metadata.'));
                } catch (error) {
                    log_runner_failure('warn callback failed', error);
                }
            }
        };

        var compose_notes = function() {
            var tokens = [];
            if (config.notes) {
                tokens.push(String(config.notes).replace(/[\r\n]+/g, ' '));
            }
            tokens.push('steps=' + state.done + '/' + state.steps.length);
            tokens.push('failures=' + state.failures);
            tokens.push('aborted=' + Boolean(state.aborted));
            tokens.push('setup=' + Boolean(setup_done));
            tokens.push('setup_recovered=' + Boolean(state.setup_recovered));
            tokens.push('visibility_lost=' + Boolean(state.visibility_lost));
            if (state.teardown_error) {
                tokens.push('teardown_error=' +
                    state.teardown_error.replace(/[\r\n;]+/g, ' '));
            }
            return tokens.join('; ');
        };

        var teardown_step = function() {
            // teardown() in a finally, like the GTK plugin
            // (plugins/bench/__init__.py:109-110), and while the probe is
            // still installed: dropping the table is a campaign RPC and
            // belongs in bench_raw.csv like any other.
            if (!setup_done) {
                return jQuery.when();
            }
            Probe.set_context({
                scenario: 'teardown',
                iteration: '',
                regime: '',
                warmup: false
            });
            return call_bench(config.plan.teardown).then(null,
                function(error) {
                    // A failed teardown leaves the table behind; it is
                    // recorded so that the next campaign knows where the
                    // residual table came from.
                    state.teardown_error = server_error_text(error);
                    return jQuery.when();
                });
        };

        var cleanup = function() {
            // The promise equivalent of the mandatory finally: reached from
            // the success path, the failure path AND the abort path.
            var dfd = jQuery.Deferred();
            var settle = function(finished) {
                if (owns_probe) {
                    Probe.uninstall();
                }
                restore_bus();
                running = false;
                dfd.resolve(finished || null);
            };
            var finalize = function() {
                try {
                    document.removeEventListener(
                        'visibilitychange', on_visibility);
                } catch (error) {
                    log_runner_failure('visibility listener not removed',
                        error);
                }
                if (owns_driver) {
                    // Removes the off-screen containers from the DOM and
                    // disconnects the IntersectionObserver of the "More" row.
                    Driver.uninstall();
                }
                if (!info) {
                    settle(null);
                    return;
                }
                info.bus_stopped = bus_attestation(bus_state);
                info.notes = compose_notes();
                Probe.finish(Runner.FINISH_GRACE_MS).then(settle, function() {
                    settle(null);
                });
            };
            teardown_step().then(finalize, finalize);
            return dfd.promise();
        };

        var should_abort = function() {
            if (typeof hooks.should_abort != 'function') {
                return false;
            }
            try {
                return Boolean(hooks.should_abort());
            } catch (error) {
                log_runner_failure('abort hook failed', error);
                return false;
            }
        };

        var record_failure = function(result, t_start) {
            // A scenario killed by a WAF guard delay, a 504 or a server
            // exception is a RESULT, not a crash: the row is written with its
            // cause and the campaign carries on.  scenario_failed is an
            // invalidating cause, so Csv.aggregate counts the row under
            // n_invalid and never lets it contribute a value: the aggregates
            // of the other scenarios cannot be skewed by it.
            // duration_ms is deliberately EMPTY: Sao opens a blocking error
            // dialog on an RPC failure (rpc.js:166-173), so a wall clock
            // duration measured here would carry the operator's reaction
            // time.  The honest time to failure is on the rpc row of
            // bench_raw.csv, closed by ajaxComplete before any dialog
            // (duration_transport_ms + http_status).
            var causes = ['scenario_failed'];
            if (result && result.error) {
                causes.push('error:' +
                    String(result.error).replace(/[\r\n;]+/g, ' '));
            }
            Probe.add_phase_sample({
                kind: 'failure',
                phase: 'failure',
                t_start_ms: Probe.elapsed(t_start),
                t_end_ms: Probe.elapsed(now()),
                duration_ms: null,
                causes: causes
            });
        };

        var notify_progress = function(step, result) {
            if (typeof hooks.progress != 'function') {
                return;
            }
            try {
                hooks.progress({
                    index: state.done,
                    total: state.steps.length,
                    scenario: step.entry.label,
                    regime: step.regime,
                    iteration: step.iteration,
                    warmup: step.warmup,
                    warmup_k: config.warmup,
                    iterations: config.iterations,
                    ok: Boolean(result && result.ok),
                    error: (result && result.error) || '',
                    failures: state.failures
                });
            } catch (error) {
                log_runner_failure('progress callback failed', error);
            }
        };

        var run_step = function(step) {
            var t_start = now();
            return Driver.run(step.entry, {
                scenario: step.entry.label,
                regime: step.regime,
                iteration: step.iteration,
                warmup: step.warmup,
                container_width: config.container_width,
                container_height: config.container_height
            }).then(null, function(error) {
                // Driver.run already folds its own failures into the result;
                // this branch only catches a defect in the driver itself, and
                // must not stop the campaign either.
                log_runner_failure('driver rejected', error);
                return jQuery.when({
                    scenario: step.entry.label,
                    type: step.entry.type,
                    regime: step.regime,
                    iteration: step.iteration,
                    warmup: step.warmup,
                    ok: false,
                    error: describe_error(error),
                    phases: {},
                    info: {}
                });
            }).then(function(result) {
                state.results.push(result);
                if (!result.ok) {
                    state.failures++;
                    record_failure(result, t_start);
                }
                state.done++;
                notify_progress(step, result);
                return result;
            });
        };

        var run_steps = function() {
            var index = 0;
            var next = function() {
                if (index >= state.steps.length) {
                    return jQuery.when();
                }
                // Cooperative abort, polled BETWEEN iterations.  Neither an
                // XHR in flight nor a server side test_db_read can be
                // cancelled from here; the stop button says exactly that.
                if (should_abort()) {
                    state.aborted = true;
                    return jQuery.when();
                }
                return run_step(state.steps[index++]).then(next);
            };
            return next();
        };

        var main = Runner.check_module().then(function(activated) {
            if (!activated) {
                return reject_message(Runner.MODULE_MISSING_MESSAGE());
            }
            return fetch_server_version();
        }).then(function(version) {
            state.server_version = version;
            bus_state = stop_bus();
            owns_probe = Probe.install();
            owns_driver = Driver.install();
            document.addEventListener('visibilitychange', on_visibility);
            info = Probe.start_campaign({
                arm: config.arm,
                iterations: config.iterations,
                warmup_k: config.warmup,
                // Selected over available: a reader can tell at once that a
                // scenario is missing from the results because it was not
                // selected, not because it vanished silently.
                plan_entries: config.entries.length + '/' + config.available,
                server_version: state.server_version,
                container_width: config.container_width,
                container_height: config.container_height,
                bus_stopped: bus_attestation(bus_state),
                notes: config.notes
            });
            // setup() is only called when a selected scenario needs the
            // technical table: it is a destructive step (CREATE then DROP),
            // and a campaign made of act_window scenarios only has no reason
            // to touch it.
            var needs_setup = config.entries.some(function(entry) {
                return entry.needs_setup;
            });
            if (!needs_setup) {
                return {done: false, recovered: false};
            }
            Probe.set_context({
                scenario: 'setup',
                iteration: '',
                regime: '',
                warmup: false
            });
            return run_setup(config.plan, hooks);
        }).then(function(setup_result) {
            setup_done = Boolean(setup_result && setup_result.done);
            state.setup_recovered = Boolean(
                setup_result && setup_result.recovered);
            return run_steps();
        });

        return main.then(function() {
            return cleanup().then(function(campaign) {
                return {
                    campaign: campaign,
                    results: state.results,
                    aborted: state.aborted,
                    failures: state.failures,
                    completed: state.done,
                    total: state.steps.length,
                    setup_recovered: state.setup_recovered,
                    teardown_error: state.teardown_error,
                    visibility_lost: state.visibility_lost
                };
            });
        }, function(error) {
            return cleanup().then(function() {
                return reject_message(error);
            });
        });
    };

    // ================================================================
    // Dialog -- configuration, progress, results and export.
    // ================================================================

    // Element ids must stay unique in the document: two dialogs can be open
    // at the same time even though only one campaign can run.
    var dialog_serial = 0;

    var confirm_dialog = function(title, lines, ok_label) {
        // Deliberately NOT Sao.common.sur: Sao.common.UniqueDialog.run
        // returns an ALREADY RESOLVED promise when its singleton is busy
        // (common.js:3440-3442), which would read here as "the operator
        // confirmed".  A destructive step must never be confirmed by a race.
        var dfd = jQuery.Deferred();
        var dialog = new Sao.Dialog(
            title, 'benchmark-confirm-dialog', 'md', false);
        // .content is a <form> (sao.js:975): a stray Enter must not submit
        // it and reload the client.
        dialog.content.submit(function(event) {
            event.preventDefault();
        });
        var alert = jQuery('<div/>', {
            'class': 'alert alert-warning',
            'role': 'alert'
        }).appendTo(dialog.body);
        lines.forEach(function(line) {
            alert.append(jQuery('<p/>').text(line));
        });
        var close = function() {
            dialog.modal.on('hidden.bs.modal', function() {
                jQuery(this).remove();
            });
            dialog.modal.modal('hide');
        };
        jQuery('<button/>', {
            'class': 'btn btn-link',
            'type': 'button',
            'title': Sao.i18n.gettext('Cancel')
        }).text(Sao.i18n.gettext('Cancel')).click(function() {
            close();
            dfd.reject();
        }).appendTo(dialog.footer);
        jQuery('<button/>', {
            'class': 'btn btn-danger',
            'type': 'button',
            'title': ok_label
        }).text(ok_label).click(function() {
            close();
            dfd.resolve();
        }).appendTo(dialog.footer);
        dialog.modal.modal('show');
        return dfd.promise();
    };

    var Dialog = Sao.class_(Object, {
        init: function() {
            dialog_serial++;
            this.serial = dialog_serial;
            this.plan = null;
            this.campaign = null;
            this.abort_requested = false;
            this.entry_inputs = [];
            // keyboard=false: ESC must not dismiss a dialog that owns a
            // running campaign.  Sao.Dialog also declares a `closeable`
            // parameter (sao.js:967) but never uses it, so the close button
            // is built here.
            this.dialog = new Sao.Dialog(
                Sao.i18n.gettext('Benchmark'), 'benchmark-dialog', 'lg',
                false);
            // .content is a <form> (sao.js:975), hence type 'button' on every
            // button below and this submit interception (pattern of
            // common.js:3448).
            this.dialog.content.submit(function(event) {
                event.preventDefault();
            });
            this.build_body();
            this.build_footer();
            this.dialog.modal.on('hidden.bs.modal', function() {
                jQuery(this).remove();
            });
        },
        id: function(name) {
            return 'benchmark-' + name + '-' + this.serial;
        },
        build_body: function() {
            var body = this.dialog.body;
            this.message_el = jQuery('<div/>').appendTo(body).sao_hide();
            this.config_el = jQuery('<div/>', {
                'class': 'benchmark-config'
            }).appendTo(body);
            this.progress_el = jQuery('<div/>', {
                'class': 'benchmark-progress'
            }).appendTo(body).sao_hide();
            this.results_el = jQuery('<div/>', {
                'class': 'benchmark-results'
            }).appendTo(body).sao_hide();
            this.build_config();
            this.build_progress();
        },
        add_group: function(parent, id, label, widget) {
            // Pattern of window.js:1531: form-group / control-label /
            // form-control.
            jQuery('<div/>', {
                'class': 'form-group'
            }).append(jQuery('<label/>', {
                'class': 'control-label',
                'for': id
            }).text(label)).append(widget).appendTo(parent);
            return widget;
        },
        build_config: function() {
            var self = this;
            var el = this.config_el;
            // Constraints 2 and 3 of the functional spec, stated BEFORE the
            // campaign can be started.
            jQuery('<div/>', {
                'class': 'alert alert-warning',
                'role': 'alert'
            }).append(jQuery('<p/>').text(Sao.i18n.gettext(
                'This campaign WRITES to the database you are connected to:' +
                ' the "DB Read" scenario inserts 100000 rows and "DB Write"' +
                ' inserts 200000, into a technical table created and dropped' +
                ' by the server. Do not run it on a production database' +
                ' without having measured the consequence.')))
                .append(jQuery('<p/>').text(Sao.i18n.gettext(
                    'The server side scenarios run their own loop of 100' +
                    ' internal repetitions on EVERY iteration you ask for,' +
                    ' so each of them can take several minutes per' +
                    ' iteration. Size the number of iterations accordingly.')))
                .append(jQuery('<p/>').text(Sao.i18n.gettext(
                    'A scenario cut short by a proxy or a WAF guard delay is' +
                    ' recorded as a result and the campaign carries on: the' +
                    ' client shows the usual server error dialog, and the' +
                    ' campaign resumes once you dismiss it.')))
                .append(jQuery('<p/>').text(Sao.i18n.gettext(
                    'Keep this tab in the foreground for the whole campaign' +
                    ' and leave the server idle, otherwise the figures are' +
                    ' not comparable. The message bus is stopped while the' +
                    ' campaign runs and started again afterwards.')))
                .appendTo(el);

            this.iterations_input = this.add_group(
                el, this.id('iterations'),
                Sao.i18n.gettext('Measured iterations per scenario'),
                jQuery('<input/>', {
                    'type': 'number',
                    'class': 'form-control',
                    'id': this.id('iterations'),
                    'min': 1,
                    'value': Runner.DEFAULT_ITERATIONS
                }));
            this.warmup_input = this.add_group(
                el, this.id('warmup'),
                Sao.i18n.gettext(
                    'Warmup iterations (measured, marked, excluded from the' +
                    ' aggregates)'),
                jQuery('<input/>', {
                    'type': 'number',
                    'class': 'form-control',
                    'id': this.id('warmup'),
                    'min': 0,
                    'value': Runner.DEFAULT_WARMUP
                }));

            this.regime_select = jQuery('<select/>', {
                'class': 'form-control',
                'id': this.id('regime')
            });
            [['both', Sao.i18n.gettext('Both regimes')],
                ['cold', Sao.i18n.gettext('cold - client caches purged' +
                    ' before every iteration')],
                ['warm', Sao.i18n.gettext('warm - caches kept, the real user' +
                    ' experience')]].forEach(function(option) {
                jQuery('<option/>', {'value': option[0]})
                    .text(option[1]).appendTo(self.regime_select);
            });
            this.add_group(
                el, this.id('regime'), Sao.i18n.gettext('Regime'),
                this.regime_select);

            this.arm_select = jQuery('<select/>', {
                'class': 'form-control',
                'id': this.id('arm')
            });
            // The arm is a CSV column, not a comment: two campaigns are
            // compared through it.  Canonical values only.
            Runner.ARMS.forEach(function(arm) {
                jQuery('<option/>', {'value': arm}).text(arm)
                    .appendTo(self.arm_select);
            });
            this.add_group(
                el, this.id('arm'),
                Sao.i18n.gettext('Arm (recorded in every CSV row)'),
                this.arm_select);

            this.notes_input = this.add_group(
                el, this.id('notes'),
                Sao.i18n.gettext('Notes (written to the campaign metadata)'),
                jQuery('<input/>', {
                    'type': 'text',
                    'class': 'form-control',
                    'id': this.id('notes')
                }));

            var entries_group = jQuery('<div/>', {
                'class': 'form-group'
            }).appendTo(el);
            jQuery('<label/>', {
                'class': 'control-label'
            }).text(Sao.i18n.gettext('Scenarios')).appendTo(entries_group);
            var buttons = jQuery('<div/>').appendTo(entries_group);
            jQuery('<button/>', {
                'class': 'btn btn-default btn-xs',
                'type': 'button',
                'title': Sao.i18n.gettext('Select all')
            }).text(Sao.i18n.gettext('Select all')).click(function() {
                self.select_entries(true);
            }).appendTo(buttons);
            buttons.append(' ');
            jQuery('<button/>', {
                'class': 'btn btn-default btn-xs',
                'type': 'button',
                'title': Sao.i18n.gettext('Select none')
            }).text(Sao.i18n.gettext('Select none')).click(function() {
                self.select_entries(false);
            }).appendTo(buttons);
            this.entries_el = jQuery('<div/>')
                .css({'max-height': '18em', 'overflow': 'auto'})
                .appendTo(entries_group);
        },
        build_progress: function() {
            var el = this.progress_el;
            this.progress_label = jQuery('<p/>').appendTo(el);
            this.progress_bar = jQuery('<div/>', {
                'class': 'progress-bar',
                'role': 'progressbar',
                'aria-valuenow': 0,
                'aria-valuemin': 0,
                'aria-valuemax': 100
            }).css('width', '0%');
            // Hand written bootstrap 3 markup: the client has NO progress
            // widget (no `progress` occurrence in src/*.js) and the CSS is
            // already there (sao.less:1606).  Sao.common.processing is not a
            // gauge either: its `queries` counter only increments inside a
            // setTimeout(..., 200) (common.js:3893-3895) while hide() starts
            // with a clearTimeout (common.js:3905), so any RPC under 200 ms
            // increments nothing at all.  It is a spinner.
            jQuery('<div/>', {'class': 'progress'})
                .append(this.progress_bar).appendTo(el);
            this.progress_detail = jQuery('<p/>', {
                'class': 'text-muted'
            }).appendTo(el);
        },
        build_footer: function() {
            var self = this;
            var footer = this.dialog.footer;
            this.close_button = jQuery('<button/>', {
                'class': 'btn btn-link',
                'type': 'button',
                'title': Sao.i18n.gettext('Close')
            }).text(Sao.i18n.gettext('Close')).click(function() {
                self.close();
            }).appendTo(footer);
            this.export_button = jQuery('<button/>', {
                'class': 'btn btn-default',
                'type': 'button',
                'title': Sao.i18n.gettext('Export the three CSV files')
            }).text(Sao.i18n.gettext('Export the three CSV files'))
                .click(function() {
                    self.export_files();
                }).appendTo(footer).sao_hide();
            this.stop_button = jQuery('<button/>', {
                'class': 'btn btn-warning',
                'type': 'button',
                'title': Sao.i18n.gettext('Stop')
            }).text(Sao.i18n.gettext('Stop')).click(function() {
                self.on_stop();
            }).appendTo(footer).sao_hide();
            this.start_button = jQuery('<button/>', {
                'class': 'btn btn-primary',
                'type': 'button',
                'title': Sao.i18n.gettext('Start the campaign')
            }).text(Sao.i18n.gettext('Start the campaign'))
                .click(function() {
                    self.on_start();
                }).appendTo(footer);
            this.start_button.prop('disabled', true);
        },
        set_message: function(text, level) {
            if (!text) {
                this.message_el.empty().sao_hide();
                return;
            }
            this.message_el.empty().append(jQuery('<div/>', {
                'class': 'alert alert-' + (level || 'info'),
                'role': 'alert'
            }).text(text)).sao_show();
        },
        set_state: function(state) {
            var configuring = (state == 'config') || (state == 'results');
            this.config_el.sao_toggle(configuring);
            this.progress_el.sao_toggle(state == 'progress');
            this.results_el.sao_toggle(state == 'results');
            this.stop_button.sao_toggle(state == 'progress');
            this.export_button.sao_toggle(state == 'results');
            this.start_button.prop(
                'disabled', !configuring || !this.plan ||
                !this.plan.activated);
            // The campaign outlives the dialog if it is closed mid-run, and
            // its progress would no longer be visible anywhere.
            this.close_button.prop('disabled', state == 'progress');
        },
        select_entries: function(checked) {
            this.entry_inputs.forEach(function(item) {
                item.input.prop('checked', checked);
            });
        },
        render_entries: function(entries) {
            var self = this;
            this.entry_inputs = [];
            this.entries_el.empty();
            if (!entries.length) {
                this.entries_el.append(jQuery('<p/>', {
                    'class': 'text-muted'
                }).text(Sao.i18n.gettext(
                    'The server declares no benchmark scenario.')));
                return;
            }
            entries.forEach(function(entry) {
                var input = jQuery('<input/>', {
                    'type': 'checkbox',
                    'id': self.id('entry-' + entry.key)
                }).prop('checked', true);
                var text = entry.needs_setup ?
                    Sao.i18n.gettext(
                        '%1 - writes to the database', entry.label) :
                    entry.label;
                jQuery('<div/>', {'class': 'checkbox'}).append(
                    jQuery('<label/>', {
                        'for': self.id('entry-' + entry.key)
                    }).append(input).append(
                        jQuery('<span/>').text(' ' + text)))
                    .appendTo(self.entries_el);
                self.entry_inputs.push({entry: entry, input: input});
            });
        },
        read_config: function() {
            var entries = [];
            this.entry_inputs.forEach(function(item) {
                if (item.input.prop('checked')) {
                    entries.push(item.entry);
                }
            });
            var regime = this.regime_select.val();
            return {
                plan: this.plan,
                entries: entries,
                available: (this.plan ? this.plan.entries.length :
                    entries.length),
                iterations: this.iterations_input.val(),
                warmup: this.warmup_input.val(),
                regimes: (regime == 'both') ?
                    Runner.REGIMES.slice() : [regime],
                arm: this.arm_select.val(),
                notes: this.notes_input.val()
            };
        },
        load: function() {
            var self = this;
            this.set_message(
                Sao.i18n.gettext('Reading the benchmark plan...'), 'info');
            return Runner.load_plan().then(function(plan) {
                self.plan = plan;
                if (!plan.activated) {
                    // Functional criterion 1: an explicit message, NO
                    // measurement, no technical error, no console trace.
                    self.set_message(plan.message, 'warning');
                    self.start_button.prop('disabled', true);
                    return plan;
                }
                self.set_message('', '');
                self.render_entries(plan.entries);
                self.start_button.prop('disabled', false);
                return plan;
            }, function(error) {
                self.set_message(describe_error(error), 'danger');
                self.start_button.prop('disabled', true);
            });
        },
        on_start: function() {
            var self = this;
            if (Runner.is_running()) {
                // Risk 10: the module level guard also refuses here, but
                // saying so before starting anything is clearer than a
                // rejected promise.
                this.set_message(Sao.i18n.gettext(
                    'Benchmark: a campaign is already running. Only one' +
                    ' campaign can run at a time, two of them would fight' +
                    ' over the same benchmark table.'), 'warning');
                return;
            }
            var config = this.read_config();
            if (!config.entries.length) {
                this.set_message(Sao.i18n.gettext(
                    'Benchmark: select at least one scenario.'), 'warning');
                return;
            }
            // Disabled before the confirmation and not after it: two quick
            // clicks would otherwise stack two confirmation dialogs, and the
            // second campaign would only be refused by the module level
            // guard, after the operator confirmed it.
            this.start_button.prop('disabled', true);
            this.confirm_start(config).then(function() {
                self.start(config);
            }, function() {
                self.start_button.prop('disabled', false);
                self.set_message(Sao.i18n.gettext(
                    'Benchmark: campaign cancelled.'), 'info');
            });
        },
        confirm_start: function(config) {
            var writing = config.entries.filter(function(entry) {
                return entry.needs_setup;
            });
            if (!writing.length) {
                return jQuery.when();
            }
            return confirm_dialog(
                Sao.i18n.gettext('Benchmark'),
                [
                    Sao.i18n.gettext(
                        'The selected scenarios WRITE to the database "%1":' +
                        ' a technical table is created, filled with up to' +
                        ' 100000 rows per read scenario and 200000 rows per' +
                        ' write scenario, then dropped at the end of the' +
                        ' campaign.',
                        String((Sao.Session.current_session || {}).database)),
                    Sao.i18n.gettext(
                        'Scenarios that write: %1.',
                        writing.map(function(entry) {
                            return entry.label;
                        }).join(', ')),
                    Sao.i18n.gettext(
                        'These benchmarks can run for several minutes each.')
                ],
                Sao.i18n.gettext('Start the campaign'));
        },
        confirm_recovery: function(lines) {
            return confirm_dialog(
                Sao.i18n.gettext('Benchmark'), lines,
                Sao.i18n.gettext('Drop the table and try again'));
        },
        start: function(config) {
            var self = this;
            this.abort_requested = false;
            this.campaign = null;
            this.set_message('', '');
            this.stop_button.prop('disabled', false)
                .text(Sao.i18n.gettext('Stop'));
            this.set_state('progress');
            this.update_progress({
                index: 0,
                total: 0,
                scenario: '',
                regime: '',
                iteration: 0,
                warmup: false,
                warmup_k: 0,
                iterations: 0,
                failures: 0
            });
            Runner.run_campaign(config, {
                progress: function(info) {
                    self.update_progress(info);
                },
                should_abort: function() {
                    return self.abort_requested;
                },
                confirm_recovery: function(lines) {
                    return self.confirm_recovery(lines);
                },
                warn: function(text) {
                    self.set_message(text, 'warning');
                }
            }).then(function(outcome) {
                self.show_results(outcome);
            }, function(error) {
                self.set_state('config');
                self.set_message(describe_error(error), 'danger');
            });
        },
        on_stop: function() {
            this.abort_requested = true;
            // Cooperative abort ONLY: should_abort() is polled between
            // iterations.  Neither the XHR in flight nor a server side
            // test_db_read can be cancelled from here, and the button says
            // exactly that rather than pretending the campaign stops at once.
            this.stop_button.prop('disabled', true).text(
                Sao.i18n.gettext('Stopping after the current iteration...'));
        },
        update_progress: function(info) {
            var total = info.total || 0;
            var percent = total ?
                Math.round((info.index / total) * 100) : 0;
            this.progress_bar
                .css('width', percent + '%')
                .attr('aria-valuenow', percent)
                .text(percent + '%');
            if (!info.scenario) {
                this.progress_label.text(Sao.i18n.gettext(
                    'Starting the campaign...'));
                this.progress_detail.text('');
                return;
            }
            if (info.warmup) {
                this.progress_label.text(Sao.i18n.gettext(
                    'Warmup iteration %1 of %2 - scenario "%3" (%4 regime)',
                    info.iteration + 1, info.warmup_k, info.scenario,
                    info.regime));
            } else {
                this.progress_label.text(Sao.i18n.gettext(
                    'Iteration %1 of %2 - scenario "%3" (%4 regime)',
                    info.iteration + 1 - info.warmup_k, info.iterations,
                    info.scenario, info.regime));
            }
            this.progress_detail.text(Sao.i18n.gettext(
                'Step %1 of %2 - %3 failed so far.',
                info.index, total, info.failures));
        },
        show_results: function(outcome) {
            this.campaign = outcome.campaign;
            this.render_results(outcome);
            this.set_state('results');
            if (outcome.aborted) {
                this.set_message(Sao.i18n.gettext(
                    'Benchmark: campaign stopped on request after %1 of %2' +
                    ' iterations. The iterations already measured are kept.',
                    outcome.completed, outcome.total), 'warning');
            } else if (outcome.failures) {
                this.set_message(Sao.i18n.gettext(
                    'Benchmark: campaign finished, %1 iterations failed and' +
                    ' are recorded with their cause in bench_raw.csv.',
                    outcome.failures), 'warning');
            } else {
                this.set_message(Sao.i18n.gettext(
                    'Benchmark: campaign finished.'), 'success');
            }
        },
        summary_lines: function(outcome) {
            var finished = outcome.campaign || {};
            var meta = finished.meta || {};
            var lines = [
                Sao.i18n.gettext('Run: %1', String(finished.run_id || '')),
                Sao.i18n.gettext('Arm: %1', String(meta.arm || '')),
                Sao.i18n.gettext(
                    'Iterations measured: %1 of %2 (warmup %3, excluded from' +
                    ' the aggregates below but kept in bench_raw.csv)',
                    outcome.completed, outcome.total,
                    String(meta.warmup_k || 0)),
                Sao.i18n.gettext('Failed iterations: %1', outcome.failures),
                Sao.i18n.gettext(
                    'Message bus: %1', String(meta.bus_stopped || ''))
            ];
            if (outcome.setup_recovered) {
                lines.push(Sao.i18n.gettext(
                    'A residual benchmark table was dropped before the' +
                    ' campaign, on your confirmation.'));
            }
            if (outcome.teardown_error) {
                lines.push(Sao.i18n.gettext(
                    'The teardown step failed: "%1". The technical table may' +
                    ' still be there; the next campaign will offer to drop' +
                    ' it.', outcome.teardown_error));
            }
            if (outcome.visibility_lost) {
                lines.push(Sao.i18n.gettext(
                    'This tab went to the background during the campaign:' +
                    ' the browser throttles its timers, so the figures of' +
                    ' that window are not comparable.'));
            }
            return lines;
        },
        render_results: function(outcome) {
            var el = this.results_el;
            el.empty();
            var summary = jQuery('<ul/>', {
                'class': 'list-unstyled'
            }).appendTo(el);
            this.summary_lines(outcome).forEach(function(line) {
                jQuery('<li/>').text(line).appendTo(summary);
            });
            var rows = outcome.campaign ? Csv.aggregate(outcome.campaign) : [];
            if (!rows.length) {
                jQuery('<p/>', {'class': 'text-muted'}).text(Sao.i18n.gettext(
                    'No aggregate row: every measured iteration was a warmup' +
                    ' or a failure. The raw file still holds every sample.'))
                    .appendTo(el);
                return;
            }
            // No reusable data grid exists outside a Sao.Screen:
            // Sao.View.Tree is bound to the Screen / Group / Record stack and
            // cannot display plain JS objects.  Plain table with the house
            // classes (view/tree.js:153).
            var table = jQuery('<table/>', {
                'class': 'tree table table-hover table-condensed'
            });
            var columns = [
                [Sao.i18n.gettext('Scenario'), 'scenario'],
                [Sao.i18n.gettext('Kind'), 'kind'],
                [Sao.i18n.gettext('Phase'), 'phase'],
                [Sao.i18n.gettext('Regime'), 'regime'],
                [Sao.i18n.gettext('n'), 'n'],
                [Sao.i18n.gettext('Invalid'), 'n_invalid'],
                [Sao.i18n.gettext('Median (ms)'), 'median'],
                [Sao.i18n.gettext('p90 (ms)'), 'p90'],
                [Sao.i18n.gettext('Max (ms)'), 'max']
            ];
            var numeric = ['median', 'p90', 'max'];
            var head = jQuery('<tr/>');
            columns.forEach(function(column) {
                jQuery('<th/>').text(column[0]).appendTo(head);
            });
            jQuery('<thead/>').append(head).appendTo(table);
            var body = jQuery('<tbody/>').appendTo(table);
            rows.forEach(function(row) {
                var tr = jQuery('<tr/>').appendTo(body);
                columns.forEach(function(column) {
                    var key = column[1];
                    var value = row[key];
                    jQuery('<td/>').text(
                        (numeric.indexOf(key) >= 0) ?
                            Csv.num(value, 2) : Csv.cell(value))
                        .appendTo(tr);
                });
            });
            jQuery('<div/>')
                .css({'max-height': '24em', 'overflow': 'auto'})
                .append(table).appendTo(el);
        },
        export_files: function() {
            // Csv.deliver hands the three files over one at a time:
            // download_file opens one modal per file and leaks its object URL
            // (common.js:4342-4367), so it is never called in a loop.
            return Csv.export_campaign(this.campaign);
        },
        show: function() {
            this.dialog.modal.modal('show');
            this.load();
            return this;
        },
        close: function() {
            this.dialog.modal.modal('hide');
        }
    });

    Sao.Benchmark.Dialog = Dialog;

    Sao.Benchmark.open = function(data) {
        // Callable from the console whatever the state of the interface:
        // Sao.Benchmark.open({}).  `data` is the plugin payload
        // ({model, model_context, id, ids, paths}, tab.js:729-735) and is
        // deliberately unused: a campaign is global and does not act on the
        // selected record.
        return new Dialog().show();
    };

    // ================================================================
    // Entry point.
    // ================================================================

    var Plugin = {};

    Plugin.get_plugins = function(model) {
        // `model` is a STRING (screen.model.name, tab.js:691), not an object.
        // Sao.Plugins (sao.js:1366) is the only extension point of the client
        // and its only consumer is Sao.Tab.Form.create_toolbar (tab.js:690),
        // so the entry shows up in the "Launch action" menu of any model tab,
        // list or form, with or without a selected record -- and nowhere
        // else.  Sao.user_menu is NOT an option: it empties itself
        // (sao.js:774) and is replayed on login and on every preference
        // change (sao.js:443, :661, :710).
        return [
            [Sao.i18n.gettext('Benchmark...'), Sao.Benchmark.open, 'action']
        ];
    };

    // Fallback for what the plugin menu cannot reach: the main menu, a Board
    // tab (tab.js:1850), a Wizard tab (create_toolbar returns an empty
    // <span/>, tab.js:1919-1921) and a desktop with no tab open.  Honest
    // limit: the shortcut works but will NOT show up in the shortcuts help
    // window -- shortcuts_defs() (sao.js:1115) returns a literal and
    // set_shortcuts() (sao.js:1269) runs once at document ready
    // (sao.js:1260), there is no registry to add to.
    Sao.Benchmark.SHORTCUT = 'alt+b';
    if (typeof Mousetrap != 'undefined') {
        Mousetrap.bind(Sao.Benchmark.SHORTCUT, function() {
            Sao.Benchmark.open({});
            return false;
        });
    }

    Sao.Plugins.push(Plugin);

}());
