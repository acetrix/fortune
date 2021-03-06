var inflect = require('i')()
  , Adapter = require('./adapter')
  , route = require('./route')
  , express = require('express')
  , RSVP = require('rsvp')
  , _ = require('lodash');

/*!
 * The Fortune object.
 */
function Fortune() {
  this._init.apply(this, arguments);
}

/**
 * An object that is passed in to the Fortune constructor, which contains all of the configuration options.
 *
 * ### Database setup
 * - `adapter`: may be either "nedb", "mongodb", "mysql", "psql", "sqlite", or an adapter object. Default: "nedb".
 * - `db`: the name of the database to use. Default: "fortune".
 * - `host`: the address of the database machine. Default: "localhost".
 * - `port`: the port of the database machine. Do not set this unless you do not plan on using the default port for the database.
 * - `username`: username for logging into the database. This may be optional for MongoDB.
 * - `password`: password for logging into the database. This may be optional for MongoDB.
 * - `flags`: an object containing additional options to pass to the adapter.
 *
 * ### Fortune setup
 * - `baseUrl`: if this is set, then your API gets upgraded to URL-style JSON API.
 * - `namespace`: optional namespace for your API, i.e. `api/v1`.
 * - `cors`: boolean value indicating whether or not to enable Cross Origin Resource Sharing (CORS). Default: true.
 * - `production`: boolean value indicating whether or not to strip spaces from responses. Default: false.
 *
 * *Note: in order to use database adapters, you must install `fortune-mongodb` for MongoDB, or `fortune-relational` for relational databases.*
 */
Fortune.prototype.options = {};

/**
 * Default application settings.
 *
 * @api private
 */
Fortune.prototype._defaults = {

  // database setup
  adapter: 'nedb',
  host: 'localhost',
  port: null,
  db: 'fortune',
  username: '',
  password: '',
  flags: {},

  // fortune options
  baseUrl: '',
  namespace: '',
  cors: true,
  production: false

};

/**
 * Constructor method.
 *
 * @api private
 * @param {Object} options
 */
Fortune.prototype._init = function(options) {
  var router;

  // Initialize options.
  options = typeof options == 'object' ? options : {};
  for(var key in this._defaults) {
    if(!options.hasOwnProperty(key))
      options[key] = this._defaults[key];
  }
  this.options = options;

  // Create the underlying express framework instance.
  this.router = express();
  router = this.router;

  // Setup express.
  if(typeof options.cors == 'boolean' || typeof options.cors == 'object' && options.cors) {
    router.use(allowCrossDomain(options.cors));
  }
  router.disable('x-powered-by');
  router.use(express.bodyParser());

  // Create a database adapter instance.
  this.adapter = new Adapter(options);
};

/**
 * Define a resource and setup routes simultaneously. A schema field may be either a native type, a plain object, or a string that refers to a related resource.
 *
 * Valid native types: `String`, `Number`, `Boolean`, `Date`, `Array`, `Buffer`
 *
 * Alternatively, the object format must be as follows:
 *
 * ```javascript
 * {type: String} // no association
 * {ref: 'relatedResource', inverse: 'relatedKey'} // "belongs to" association to "relatedKey" key on "relatedResource"
 * [{ref: 'anotherResource', inverse: 'someKey'}] // "has many" association to "someKey" on "anotherResource"
 * ```
 *
 * @param {String} name the name of the resource
 * @param {Object} schema the schema object to add
 * @param {Object} options additional options to pass to the schema
 * @return {this}
 */
Fortune.prototype.resource = function(name, schema, options) {
  var _this = this;

  this._resource = name;
  if(typeof schema != 'object') return this;
  if(this.adapter.model(name)) {
    console.warn('Warning: resource "' + name + '" was already defined.');
    return this;
  }

  this.adapter.awaitConnection().then(function() {
    schema = _this._scrubSchema(schema);

    // Store a copy of the input.
    _this._schema[name] = _.clone(schema);

    try {
      schema = _this.adapter.schema(name, schema, options);
      _this._route(name, _this.adapter.model(name, schema));
    } catch(error) {
      console.trace('There was an error loading the "' + name + '" resource. ' + error);
    }
  }, function(error) {
    throw error;
  });
  return this;
};

/**
 * Scrub keys on a schema before passing it off to the adapter.
 *
 * @api private
 * @param {Object} schema
 * @return {Object}
 */
Fortune.prototype._scrubSchema = function(schema) {
  ['id', 'href', 'links'].forEach(function(reservedKey) {
    if(schema.hasOwnProperty(reservedKey)) {
      delete schema[reservedKey];
      console.warn('Reserved key "' + reservedKey + '" is not allowed.');
    }
  });
  return schema;
};

/**
 * Internal method to add transforms on a resource.
 *
 * @api private
 * @param {String} name
 * @param {Function} fn
 * @param {String} stage
 */
Fortune.prototype._addTransform = function(name, fn, stage) {
  var _this = this;

  if(typeof name == 'function') {
    fn = name;
    name = this._resource;
  }
  if(typeof fn == 'function') {
    name.split(' ').forEach(function(key) {
      _this[stage][key] = fn;
    });
  }
};

/**
 * Do something before a resource is saved in the database. The function parameter defines a promise that can be resolved or rejected, and also has a third argument, the request object. Here's a contrived example that stores the Authorization header into the resource:
 *
 * ```javascript
 * function(resolve, reject, request) {
 *   var authorization = request.get('Authorization');
 *   if(!authorization) return reject();
 *   this.authorization = authorization;
 *   resolve(this);
 * }
 * ```
 *
 * @param {String} name may be space separated, i.e. 'cat dog human'
 * @param {Function} fn this method is called within the context of the resource, it has 3 parameters: 2 callbacks to resolve or reject the transform, and the request object.
 * @return {this}
 */
Fortune.prototype.before = function(name, fn) {
  this._addTransform(name, fn, '_before');
  return this;
};

/**
 * Do something after a resource is read from the database. Here's a contrived example that hides a `password` and `salt` from being exposed:
 *
 * ```javascript
 * function(resolve, reject, request) {
 *   delete this.password;
 *   delete this.salt;
 *   resolve(this);
 * }
 * ```
 *
 * @param {String} name may be space separated, i.e. 'cat dog human'
 * @param {Function} fn this method is called within the context of the resource, it has 3 parameters: 2 callbacks to resolve or reject the transform, and the request object.
 * @return {this}
 */
Fortune.prototype.after = function(name, fn) {
  this._addTransform(name, fn, '_after');
  return this;
};

/**
 * Convenience method to define before & after at once.
 *
 * @param {String} [name] if no name is passed, the last defined resource is used
 * @param {Function} before see "before" method
 * @param {Function} after see "after" method
 * @return {this}
 */
Fortune.prototype.transform = function(name, before, after) {
  if(arguments.length < 3) {
    after = before;
    before = name;
    name = this._resource;
  }
  this.before(name, before);
  this.after(name, after);
  return this;
};

/**
 * This accepts a `connect` middleware function. For more information, [here is a guide for how to write connect middleware](http://stephensugden.com/middleware_guide/).
 *
 * @param {Function} fn connect middleware
 * @return {this}
 */
Fortune.prototype.use = function() {
  var router = this.router;
  router.use.apply(router, arguments);
  return this;
};

/**
 * Start the API by listening on the specified port.
 *
 * @param {Number} port the port number to use
 * @return {this}
 */
Fortune.prototype.listen = function() {
  var router = this.router;
  router.listen.apply(router, arguments);
  console.log('A fortune is available on port ' + arguments[0] + '...');
  return this;
};

/**
 * Internal method to remove HTTP routes from a resource.
 *
 * @api private
 * @param {String} name
 * @param {Array} methods
 * @param {Array} [routes]
 */
Fortune.prototype._removeRoutes = function(name, methods, routes) {
  var router = this.router
    , collection = inflect.pluralize(name)
    , re = new RegExp('\/' + collection);

  this.adapter.awaitConnection().then(function() {
    (methods || []).forEach(function(verb) {
      var paths = router.routes[verb];
      paths.forEach(function(route, index) {
        if(routes ? _.contains(routes, route.path) : re.test(route.path)) {
          paths.splice(index, 1);
        }
      });
    });
  });
};

/**
 * Mark a resource as read-only, which destroys the routes
 * for `POST`, `PUT`, `PATCH`, and `DELETE` on that resource. The resource
 * can still be modified using adapter methods.
 *
 * @param {String} [name] if no name is passed, the last defined resource is used.
 * @return {this}
 */
Fortune.prototype.readOnly = function(name) {
  if(typeof name != 'string') name = this._resource;
  this._removeRoutes(name, ['post', 'put', 'patch', 'delete']);
  return this;
};

/**
 * Mark a resource as not having an index, which destroys the `GET` index.
 *
 * @param {String} [name] if no name is passed, the last defined resource is used.
 * @return {this}
 */
Fortune.prototype.noIndex = function(name) {
  if(typeof name != 'string') name = this._resource;
  var index = this.options.namespace + '/' + inflect.pluralize(name);
  this._removeRoutes(name, ['get'], [index]);
  return this;
};

/**
 * Namespace for the router, which is actually an instance of `express`.
 */
Fortune.prototype.router = {};

/**
 * Namespace for the adapter.
 */
Fortune.prototype.adapter = {};

/**
 * Store loaded schemas here.
 *
 * @api private
 */
Fortune.prototype._schema = {};

/**
 * Store methods to transform input.
 *
 * @api private
 */
Fortune.prototype._before = {};

/**
 * Store methods to transform output.
 *
 * @api private
 */
Fortune.prototype._after = {};

/**
 * Method to route a resource.
 *
 * @api private
 */
Fortune.prototype._route = route;

/**
 * Keep track of the last added resource so that we can
 * chain methods that act on resources.
 *
 * @api private
 */
Fortune.prototype._resource = '';


// Default Cross-Origin Resource Sharing setup.
function allowCrossDomain(cors) {

  var headers = cors.headers || ['Accept', 'Content-Type', 'Authorization', 'X-Requested-With'],
      methods = cors.methods || ['GET', 'PUT', 'POST', 'PATCH', 'DELETE'],
      origins = cors.origins || '*',
      credentials = cors.credentials || true;

  return function(req, res, next) {
    if(!req.get('Origin')) return next();

    if(origins !== '*') {
      if(origins.indexOf(req.get('Origin'))) {
        origins = req.get('Origin');
      } else {
        next();
      }
    }

    res.header('Access-Control-Allow-Origin', origins);
    res.header('Access-Control-Allow-Headers', headers.join(', '));
    res.header('Access-Control-Allow-Methods', methods.join(', '));
    res.header('Access-Control-Allow-Credentials', credentials.toString());
    // intercept OPTIONS method
    if(req.method == 'OPTIONS') {
      res.send(200);
    } else {
      next();
    }
  }
}

/*!
 * Create instance of Fortune.
 *
 * @param {Object} options
 */
function create(options) {
  return new Fortune(options);
}

// Expose create method
exports = module.exports = create;

// Expose adapters.
exports.adapters = Adapter.adapters;

// Expose express framework
exports.express = express;

// Expose RSVP Promise library
exports.RSVP = RSVP;
