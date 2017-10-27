const Logger = require('../logger');
const api = require('@ucd-lib/fin-node-api');
const fs = require('fs');
const pathutils = require('../pathutils');
const prefixutils = require('../prefixutils');
const inquirer = require('inquirer');
const config = require('../models/ConfigModel');

/**
 * @class HttpCli
 * @description Handle http commands
 */
class HttpCli {

  async init(vorpal, argv) {
    this.vorpal = vorpal;

    // get
    this._stdOptionWrapper(
      vorpal.command('http get [path]')
      .description('Retrieve the content of the resource')
      .action(this.get.bind(this))
    );

    // post
    this._stdOptionWrapper(
      vorpal.command('http post [path]')
      .description('Create new resources within a LDP container')
      .option('-p --prefix <prefix>', 'Additional header prefix')
      .option('-@ --data-binary <binary>', 'Specify a data file to add.  Can be to stdin')
      .option('-t --data-string <data>', 'Specify a string to be used as turtle formatted triples, use defined prefixes')
      .action(this.post.bind(this))
    );

    // put
    this._stdOptionWrapper(
      vorpal.command('http put [path]')
      .description('Create a resource with a specified path, or replace the triples associated with a resource with the triples provided in the request body')
      .option('-p --prefix <prefix>', 'Additional header prefix')
      .option('-@ --data-binary <binary>', 'Specify a data file to add.  Can be to stdin')
      .option('-t --data-string <data>', 'Specify a string to be used as turtle formatted triples, use defined prefixes')
      .action(this.put.bind(this))
    );

    // patch
    this._stdOptionWrapper(
      vorpal.command('http patch [path]')
      .description('Modify the triples associated with a resource with SPARQL-Update')
      .option('-p --prefix <prefix>', 'Additional header prefix')
      .option('-@ --data-binary <binary>', 'Specify a data file to add.  Can be to stdin')
      .option('-t --data-string <data>', 'Specify a string to be used as turtle formatted triples, use defined prefixes')
      .action(this.patch.bind(this))
    );

    // delete
    this._stdOptionWrapper(
      vorpal.command('http delete [path]')
      .description('Delete a resource')
      .action(this.delete.bind(this))
    );

    // head
    this._stdOptionWrapper(
      vorpal.command('http head [path]')
      .description('Retrieve the resource headers')
      .action(this.head.bind(this))
    );

    // move
    this._stdOptionWrapper(
      vorpal.command('http move <path> <destination>')
      .description('Move a resource (and its subtree) to a new location')
      .action(this.move.bind(this))
    );

    // copy
    this._stdOptionWrapper(
      vorpal.command('http copy <path> <destination>')
      .description('Copy a resource (and its subtree) to a new location')
      .action(this.copy.bind(this))
    );
  }

  /**
   * @method
   * @private
   * 
   * @description wrap standard options for all http methods
   */
  _stdOptionWrapper(command) {
    command.option('-H, --header <header>', 'Add additional Headers to the request')
           .option('-P, --print <print>', 'Specify what components to print to user. Value should '+
                    'be any combination of hbHB where: H=request headers, B=request body,'+
                    'h=response headers and b=response body');
  }

  /**
   * @method
   * @private
   * @description parse given HTTP headers from command line and set to HTTP options
   * 
   * @param {Object} options HTTP request options 
   * @param {Object} args command line options
   */
  _appendHeaders(options, args) {
    if( !args.header ) return;
    if( Array.isArray(args.header) ) {
      args.header.forEach(header => this._appendHeader(options, header));
    } else {
      this._appendHeader(options, args.header);
    }
  }

  /**
   * @method
   * @private
   * @description parse given HTTP header from command line and set to HTTP options
   * 
   * @param {Object} options HTTP request options 
   * @param {String} header HTTP header
   */
  _appendHeader(options, header) {
    try {
      let parts = header.split(':').map(part => part.trim());
      options.headers[parts.shift()] = parts.join(':');
    } catch(e) {
      throw new Error(`Invalid HTTP header: ${header}`);
    }
  }

  /**
   * @method
   * @private
   * 
   * @description parse the print arguments
   * @param {Object} args command line options
   */
  _parseDisplayOptions(args) {
    let printOptions = {
      H : false,
      B : false,
      h : false,
      b : false
    }

    if( args.options.print ) {
      for( var key in printOptions ) {
        if( args.options.print.indexOf(key) > -1 ) {
          printOptions[key] = true;
        }
      }
    }

    return printOptions;
  }

  /**
   * @method
   * @private
   * 
   * @description print results of HTTP method
   * 
   * @param {Object} args command args
   * @param {Object} response HTTP response object
   */
  _display(args, response) {
    let print = this._parseDisplayOptions(args);
    let request = response.request;

    if( print.H ) {
      Logger.log(`${request.method} ${request.href}`);
      this._displayHeaders(request.headers);
      Logger.log('');
    }

    if( print.B && request.body ) {
      Logger.log(request.body);
      Logger.log();
    }

    if( print.h ) {
      Logger.log(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`);
      this._displayHeaders(response.headers);
      Logger.log('');
    }

    if( print.b && response.body ) {
      Logger.log(response.body);
      Logger.log();
    }
  }

  /**
   * @method
   * @private
   * 
   * @description print HTTP headers to stdout
   * @param {Object} headers key/value pair hash
   */
  _displayHeaders(headers) {
    if( !headers ) return;
    for( var key in headers ) {
      Logger.log(`${key}: ${headers[key]}`);
    }
  }

  /**
   * @method
   * @private
   * 
   * @description parse/handle the data-binary and data-string options for post/put cmds
   * 
   * @param {Object} args command args
   * @param {Object} options HTTP request options
   * @returns {Boolean} was valid file or contents passed
   */
  _parseDataOptions(args, options, sparql = false) {
    if( args.options['data-binary'] ) {
      // prompt user for input
      if( args.options['data-binary'].toLowerCase() === 'stdin' ) {
        var input = inquirer.prompt([{
          type: 'text',
          name: 'postdata'
        }]);
        options.content = input.postdata;

      } else if( args.options['data-binary'].toLowerCase() === '/dev/stdin' ) {
        options.content = fs.readFileSync('/dev/stdin', 'utf-8');

      // set file from file system
      } else {
        options.file = pathutils.makeAbsolutePath(args.options['data-binary']);
        if( !fs.existsSync(options.file) ) {
          Logger.error(`Invalid file: ${options.file}`);
          return false;
        }
      }

    } else if( args.options['data-string'] ) {
      let prefixes = prefixutils(args, sparql);
      options.content = prefixes+'\n'+args.options['data-string'];
      options.headers['Content-Type'] = api.RDF_FORMATS.TURTLE;
    }

    return true;
  }

  /**
   * @method
   * @private
   * 
   * @description initialize the HTTP request options object for given path and headers
   * 
   * @param {Object} args Command line arguments
   * @returns {Object} HTTP request options
   */
  _initOptions(args) {
    let options = {
      path : pathutils.makeAbsoluteFcPath(args.path || '.'),
      headers : {}
    }

    // parse headers
    if( args.options.header ) {
      this._appendHeaders(options, args.options);
    }

    return options;
  }

  /**
   * @method get
   * @description Handle 'http get' command
   * 
   * @param {Object} args Command line arguments 
   */
  async get(args) {
    let options = this._initOptions(args);
    let {response, body} = await api.get(options);
    this._display(args, response);
    return {response, options};
  }

  /**
   * @method post
   * @description Handle 'http post' command
   * 
   * @param {Object} args Command line arguments 
   */
  async post(args) {
    let options = this._initOptions(args);

    let success = this._parseDataOptions(args, options);
    if( !success ) return;

    let {response, body} = await api.post(options);
    this._display(args, response);
    return {response, options};
  }

  /**
   * @method put
   * @description Handle 'http put' command
   * 
   * @param {Object} args Command line arguments 
   */
  async put(args) {
    let options = this._initOptions(args);

    let success = this._parseDataOptions(args, options);
    if( !success ) return;

    let {response, body} = await api.put(options);
    this._display(args, response);
    return {response, options};
  }

  /**
   * @method patch
   * @description Handle 'http patch' command
   * 
   * @param {Object} args Command line arguments 
   */
  async patch(args) {
    let options = this._initOptions(args);
    options.headers['Content-Type'] = 'application/sparql-update';

    let success = this._parseDataOptions(args, options, true);
    if( !success ) return;

    let {response, body} = await api.patch(options);
    this._display(args, response);
    return {response, options};
  }

  /**
   * @method delete
   * @description Handle 'http delete' command
   * 
   * @param {Object} args Command line arguments 
   */
  async delete(args) {
    let options = this._initOptions(args);

    let {response, body} = await api.delete(options);
    this._display(args, response);
    return {response, options};
  }

  /**
   * @method head
   * @description Handle 'http head' command
   * 
   * @param {Object} args Command line arguments 
   */
  async head(args) {
    let options = this._initOptions(args);

    let {response, body} = await api.head(options);
    this._display(args, response);
    return {response, options};
  }

  /**
   * @method move
   * @description Handle 'http move' command
   * 
   * @param {Object} args Command line arguments 
   */
  async move(args) {
    let options = this._initOptions(args);

    if( args.destination ) {
      options.destination = pathutils.makeAbsoluteFcPath(args.destination);
    }
  
    let {response, body} = await api.move(options);
    this._display(args, response);
    return {response, options};
  }

  /**
   * @method copy
   * @description Handle 'http copy' command
   * 
   * @param {Object} args Command line arguments 
   */
  async copy(args) {
    let options = this._initOptions(args);

    if( args.destination ) {
      options.destination = pathutils.makeAbsoluteFcPath(args.destination);
    }
  
    let {response, body} = await api.copy(options);
    this._display(args, response);
    return {response, options};
  }

}

module.exports = new HttpCli();