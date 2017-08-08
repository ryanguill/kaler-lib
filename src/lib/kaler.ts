import mocha = require('mocha');
import chai = require('chai');
import * as _ from 'lodash';
import util = require('util');
import * as moment from 'moment';

// npm run compile && ./node_modules/.bin/mocha --ui tdd dist/lib/kaler.js

function excelColumnNameForIndex (idx : number) : string {
	let output = '';
	for (let a = 1, b = 26; (idx -= a) >= 0; a = b, b *=26 ) {
		output = String.fromCharCode(((idx % b) / a) + 65) + output;
	}

	return output;
}

interface ParseConfig {
	firstLineHeaders: boolean;
	convertNull: boolean;
	convertEmptyString: boolean;
}

interface ParseResultColumn {
	name: string;
	type: string;
}

interface ParseResult {
	data: any[];
	headers: ParseResultColumn[];
}


function determineBestDataTypeForColumn (input: any[], column: ParseResultColumn) : ParseResultColumn {
	//slice out just that one columns worth of data
	const data = input.map(row => row[column.name])
		.filter(cell => cell !== null); //remove nulls so it doesn't skew results


	//possible datatypes: varchar | numeric | datetime | boolean

	const possibleBooleanValues : any[] = [true, false, 1, 0, '1', '0', 'TRUE', 'FALSE', 'true', 'false'];

	if (data.every(cell => possibleBooleanValues.includes(cell))) {
		column.type = 'boolean';
		return column;
	}

	//use a regex to see if there are only digits
	if (data.every(cell => /^(0|[1-9][0-9]*)$/.test(cell))) {
		column.type = 'numeric';
		return column;
	}

	const possibleDateFormats = [moment.ISO_8601, 'MM/DD/YYYY', 'YYYY-MM-DD'];
	//if the value matches a date format
	if (data.every(cell => moment(cell, possibleDateFormats, true).isValid())) {
		column.type = 'datetime';
		return column;
	}

	column.type = 'varchar';
	return column;

}

function parseTabDelim (input : String, config : ParseConfig) : ParseResult {

	let output : any[] = input.split(`\n`)
		.map(function (line : string) : string[] {
			return line.split('\t');
		});

	let headerNames : string[] = [];
	if (config.firstLineHeaders) {
		headerNames = output.shift() || [];
	}
	//get the longest array
	const longestRow = output.reduce(function (agg : number, row : string[]) {
		return Math.max(agg, row.length);
	}, 0);

	if (headerNames.length < longestRow) {
		//const excelHeaders :string []; _.times(longestRow, (idx) => headerNames.push(excelColumnNameForIndex(idx + 1)));
		for (let idx = headerNames.length; idx < longestRow; idx++) {
			headerNames.push(excelColumnNameForIndex(idx+1));
		}

	}


	let headers = headerNames.map((header : string) : ParseResultColumn => ({name: header, type: 'varchar'}));

	output = output.map(function (row : string[]) {
		const rowObj : any = {};
		row.forEach(function (cell : string | null, idx : number) {
			if (config.convertEmptyString && typeof cell === 'string' && cell.toUpperCase() === 'EMPTYSTRING') {
				cell = '';
			} else if (config.convertNull && typeof cell === 'string' && cell.toUpperCase() === 'NULL') {
				cell = null;
			}
			rowObj[headers[idx]['name']] = cell;
		});
		return rowObj;
	});

	headers = headers.map(header => determineBestDataTypeForColumn(output, header));

	//now that we have the real headers, go through them and convert the data if necessary
	output = output.map(function (row) {
		return _.mapValues(row, function (value : any, key : string) {
			const header = headers.find(header => header.name === key);
			if (header === undefined) {
				//should never happen but have to handle the possibility
				return value;
			}
			if (value === null) {
				return value;
			}
			if (header.type === 'boolean') {
				if ([true, 1, '1', 'true', 'TRUE'].includes(value)) {
					return true;
				}
				return false;
			}
			if (header.type === 'numeric') {
				return Number(value);
			}
			if (header.type === 'datetime') {
				return moment.utc(value).toDate();
			}
			return value;
		});
	});

	return {data: output, headers};
}

function toPgInsert (input : ParseResult, tableName : string = 'tableName') : string {

	function rowTemplate (row: any[], columns: ParseResultColumn[]) : string {
		let output : string = `(`;

		output += _.map(row, (value, key: string) => {
			const col = _.find(columns, {'name':key});
			if (col === undefined) {
				//should never happen but have to protect against it
				return value;
			}
			//console.log({col, key, value});

			if (value === null) {
				return `NULL`;
			}

			if (col.type === 'boolean') {
				if (value) {
					return `TRUE`;
				} else {
					return `FALSE`;
				}
			}
			if (['numeric'].includes(col.type)) {
				return value;
			}
			if (['datetime'].includes(col.type)) {
				return `'${moment.utc(value).toISOString()}'`;
			}
			return `'${value}'`;
		}).join(', ');

		return output + ')';
	}

	function columnTemplate (column : ParseResultColumn) : string {

		let type = column.type;
		if (type === 'datetime') {
			type = 'timestamptz';
		}

		return `${column.name} ${type}`;
	}

	return `
DROP TABLE IF EXISTS ${tableName} CASCADE;
CREATE TABLE ${tableName} (
	 ${input.headers.map(header => {
		return ` ${columnTemplate(header)}`;
	}).join('\n\t,')}
);

INSERT INTO ${tableName} ( ${_.map(input.headers, 'name').join(', ')} ) VALUES
  ${input.data.map(row => rowTemplate(row, input.headers)).join('\n, ')}
;`;
}

/*
===============================================================================
UNIT TESTS - only runs when unit testing
===============================================================================
*/
if (process.argv.length > 1 && process.argv[1].includes('mocha')) {

	let expect = chai.expect;
	let assert = chai.assert;

	suite(__filename.split('/').reverse()[0] + ' tests', function () {

		test('parseTabDelim', async function () {
			const input = `a	b	c	d	e	f
1	a	January	2001-01-01	TRUE	1
2	b	February	2002-01-01	FALSE	2
3	c	March	2003-01-01	1	3
4	d	April	2004-01-01	0	4
5	e	May	2005-01-01	true	5
6	f	June	2006-01-01	false	6
7	g	July	2007-01-01	TRUE	7
8	h	August	2008-01-01	FALSE	8
9	i	September	2009-01-01	TRUE	9
10	j	October	2010-01-01	FALSE	10
11	k	November	2011-01-01	TRUE	a`;

			const output = parseTabDelim(input, {
				firstLineHeaders: true,
				convertNull: true,
				convertEmptyString: true
			});

			expect(output).to.be.an('object');
			expect(output).to.have.keys(['data','headers']);
			expect(output.data).to.be.an('array');
			expect(output.data).to.have.lengthOf(11);
			expect(output.headers).to.be.an('array').to.have.lengthOf(6);
			expect(_.map(output.headers, 'name')).to.deep.equal(['a','b','c','d','e','f']);

			//console.log(util.inspect(output));

			//console.log(toPgInsert(output));

		});

		test('parseTabDelim_emptystring', async function () {
					const input = `a	b	c	d	e	f
1	a	January	2001-01-01	TRUE	1
2	b	emptystring	2002-01-01	FALSE	2
3	c		2003-01-01	1	3`;

			const output = parseTabDelim(input, {
				firstLineHeaders: true,
				convertNull: true,
				convertEmptyString: true
			});

			expect(output.data[1].c).to.equal('');
			expect(output.data[2].c).to.equal('');
		});

		test('parseTabDelim_null', async function () {
					const input = `a	b	c	d	e	f
null	a	January	2001-01-01	TRUE	1
2	b	null	2002-01-01	FALSE	2
3	c		null	1	3`;

			const output = parseTabDelim(input, {
				firstLineHeaders: true,
				convertNull: true,
				convertEmptyString: true
			});

//console.log(util.inspect(output));
//console.log(toPgInsert(output));


			expect(output.data[0].a).to.equal(null);
			expect(output.data[1].c).to.equal(null);
			expect(output.data[2].d).to.equal(null);
		});

		test('excel-columns', async function () {
					const input = `1	2	3	4	5	6	7	8	9	10`;

			const output = parseTabDelim(input, {
				firstLineHeaders: false,
				convertNull: false,
				convertEmptyString: false
			});

//console.log(util.inspect(output));
//console.log(toPgInsert(output));

			expect(_.map(output.headers, 'name')).to.deep.equal(['A','B','C','D','E','F','G','H','I','J']);
		});

		test('excel-columns-filler', async function () {
					const input = `a	b	c	d	e	f
1	2	3	4	5	6	7	8	9	10`;

			const output = parseTabDelim(input, {
				firstLineHeaders: true,
				convertNull: false,
				convertEmptyString: false
			});

			expect(_.map(output.headers, 'name')).to.deep.equal(['a','b','c','d','e','f','G','H','I','J']);
		});


	});
}
