import Backbone from 'backbone';
import { Collection as BBCollection, Model as BBModel } from 'backbone';
import _ from 'underscore';
import Semaphore from './utils/semaphore';
import BlockingQueue from './utils/blocking-queue';
import eventQueue from './event-queue';
import BObject from './utils/object';
import config from './config';
import Collection from './collection';
import relationTypeStore from './relation-type-store';
import Store from './utils/store';
import store from './store';
import Relation from './relation';

const module = config;

module.Collection = Collection;
module.Semaphore = Semaphore;
module.BlockingQueue = BlockingQueue;
module.eventQueue = eventQueue;
module.relationTypeStore = relationTypeStore;

module.Store = Store;
module.store = store;

module.Relation = Relation;

module.HasOne = module.Relation.extend({
	options: {
		reverseRelation: { type: 'HasMany' }
	},

	initialize: function( opts ) {
		this.listenTo( this.instance, 'relational:change:' + this.key, this.onChange );

		var related = this.findRelated( opts );
		this.setRelated( related );

		// Notify new 'related' object of the new relation.
		_.each( this.getReverseRelations(), function( relation ) {
			relation.addRelated( this.instance, opts );
		}, this );
	},

	/**
	 * Find related Models.
	 * @param {Object} [options]
	 * @return {Backbone.Model}
	 */
	findRelated: function( options ) {
		var related = null;

		options = _.defaults( { parse: this.options.parse }, options );

		if ( this.keyContents instanceof this.relatedModel ) {
			related = this.keyContents;
		}
		else if ( this.keyContents || this.keyContents === 0 ) { // since 0 can be a valid `id` as well
			var opts = _.defaults( { create: this.options.createModels }, options );
			related = this.relatedModel.findOrCreate( this.keyContents, opts );
		}

		// Nullify `keyId` if we have a related model; in case it was already part of the relation
		if ( related ) {
			this.keyId = null;
		}

		return related;
	},

	/**
	 * Normalize and reduce `keyContents` to an `id`, for easier comparison
	 * @param {String|Number|Backbone.Model} keyContents
	 */
	setKeyContents: function( keyContents ) {
		this.keyContents = keyContents;
		this.keyId = module.store.resolveIdForItem( this.relatedModel, this.keyContents );
	},

	/**
	 * Event handler for `change:<key>`.
	 * If the key is changed, notify old & new reverse relations and initialize the new relation.
	 */
	onChange: function( model, attr, options ) {
		// Don't accept recursive calls to onChange (like onChange->findRelated->findOrCreate->initializeRelations->addRelated->onChange)
		if ( this.isLocked() ) {
			return;
		}
		this.acquire();
		options = options ? _.clone( options ) : {};

		// 'options.__related' is set by 'addRelated'/'removeRelated'. If it is set, the change
		// is the result of a call from a relation. If it's not, the change is the result of
		// a 'set' call on this.instance.
		var changed = _.isUndefined( options.__related ),
			oldRelated = changed ? this.related : options.__related;

		if ( changed ) {
			this.setKeyContents( attr );
			var related = this.findRelated( options );
			this.setRelated( related );
		}

		// Notify old 'related' object of the terminated relation
		if ( oldRelated && this.related !== oldRelated ) {
			_.each( this.getReverseRelations( oldRelated ), function( relation ) {
				relation.removeRelated( this.instance, null, options );
			}, this );
		}

		// Notify new 'related' object of the new relation. Note we do re-apply even if this.related is oldRelated;
		// that can be necessary for bi-directional relations if 'this.instance' was created after 'this.related'.
		// In that case, 'this.instance' will already know 'this.related', but the reverse might not exist yet.
		_.each( this.getReverseRelations(), function( relation ) {
			relation.addRelated( this.instance, options );
		}, this );

		// Fire the 'change:<key>' event if 'related' was updated
		if ( !options.silent && this.related !== oldRelated ) {
			var dit = this;
			this.changed = true;
			module.eventQueue.add( function() {
				dit.instance.trigger( 'change:' + dit.key, dit.instance, dit.related, options, true );
				dit.changed = false;
			});
		}
		this.release();
	},

	/**
	 * If a new 'this.relatedModel' appears in the 'store', try to match it to the last set 'keyContents'
	 */
	tryAddRelated: function( model, coll, options ) {
		if ( ( this.keyId || this.keyId === 0 ) && model.id === this.keyId ) { // since 0 can be a valid `id` as well
			this.addRelated( model, options );
			this.keyId = null;
		}
	},

	addRelated: function( model, options ) {
		// Allow 'model' to set up its relations before proceeding.
		// (which can result in a call to 'addRelated' from a relation of 'model')
		var dit = this;
		model.queue( function() {
			if ( model !== dit.related ) {
				var oldRelated = dit.related || null;
				dit.setRelated( model );
				dit.onChange( dit.instance, model, _.defaults( { __related: oldRelated }, options ) );
			}
		});
	},

	removeRelated: function( model, coll, options ) {
		if ( !this.related ) {
			return;
		}

		if ( model === this.related ) {
			var oldRelated = this.related || null;
			this.setRelated( null );
			this.onChange( this.instance, model, _.defaults( { __related: oldRelated }, options ) );
		}
	}
});

module.HasMany = module.Relation.extend({
	collectionType: null,

	options: {
		reverseRelation: { type: 'HasOne' },
		collectionType: module.Collection,
		collectionKey: true,
		collectionOptions: {}
	},

	initialize: function( opts ) {
		this.listenTo( this.instance, 'relational:change:' + this.key, this.onChange );

		// Handle a custom 'collectionType'
		this.collectionType = this.options.collectionType;
		if ( _.isFunction( this.collectionType ) && this.collectionType !== module.Collection && !( this.collectionType.prototype instanceof module.Collection ) ) {
			this.collectionType = _.result( this, 'collectionType' );
		}
		if ( _.isString( this.collectionType ) ) {
			this.collectionType = module.store.getObjectByName( this.collectionType );
		}
		if ( this.collectionType !== module.Collection && !( this.collectionType.prototype instanceof module.Collection ) ) {
			throw new Error( '`collectionType` must inherit from module.Collection' );
		}

		var related = this.findRelated( opts );
		this.setRelated( related );
	},

	/**
	 * Bind events and setup collectionKeys for a collection that is to be used as the backing store for a HasMany.
	 * If no 'collection' is supplied, a new collection will be created of the specified 'collectionType' option.
	 * @param {module.Collection} [collection]
	 * @return {module.Collection}
	 */
	_prepareCollection: function( collection ) {
		if ( this.related ) {
			this.stopListening( this.related );
		}

		if ( !collection || !( collection instanceof module.Collection ) ) {
			var options = _.isFunction( this.options.collectionOptions ) ?
				this.options.collectionOptions( this.instance ) : this.options.collectionOptions;

			collection = new this.collectionType( null, options );
		}

		collection.model = this.relatedModel;

		if ( this.options.collectionKey ) {
			var key = this.options.collectionKey === true ? this.options.reverseRelation.key : this.options.collectionKey;

			if ( collection[ key ] && collection[ key ] !== this.instance ) {
				if ( module.showWarnings && typeof console !== 'undefined' ) {
					console.warn( 'Relation=%o; collectionKey=%s already exists on collection=%o', this, key, this.options.collectionKey );
				}
			}
			else if ( key ) {
				collection[ key ] = this.instance;
			}
		}

		this.listenTo( collection, 'relational:add', this.handleAddition )
			.listenTo( collection, 'relational:remove', this.handleRemoval )
			.listenTo( collection, 'relational:reset', this.handleReset );

		return collection;
	},

	/**
	 * Find related Models.
	 * @param {Object} [options]
	 * @return {module.Collection}
	 */
	findRelated: function( options ) {
		var related = null;

		options = _.defaults( { parse: this.options.parse }, options );

		// Replace 'this.related' by 'this.keyContents' if it is a module.Collection
		if ( this.keyContents instanceof module.Collection ) {
			this._prepareCollection( this.keyContents );
			related = this.keyContents;
		}
		// Otherwise, 'this.keyContents' should be an array of related object ids.
		// Re-use the current 'this.related' if it is a module.Collection; otherwise, create a new collection.
		else {
			var toAdd = [];

			_.each( this.keyContents, function( attributes ) {
				var model = null;

				if ( attributes instanceof this.relatedModel ) {
					model = attributes;
				}
				else {
					// If `merge` is true, update models here, instead of during update.
					model = ( _.isObject( attributes ) && options.parse && this.relatedModel.prototype.parse ) ?
						this.relatedModel.prototype.parse( _.clone( attributes ), options ) : attributes;
				}

				model && toAdd.push( model );
			}, this );

			if ( this.related instanceof module.Collection ) {
				related = this.related;
			}
			else {
				related = this._prepareCollection();
			}

			// By now, `parse` will already have been executed just above for models if specified.
			// Disable to prevent additional calls.
			related.set( toAdd, _.defaults( { parse: false }, options ) );
		}

		// Remove entries from `keyIds` that were already part of the relation (and are thus 'unchanged')
		this.keyIds = _.difference( this.keyIds, _.pluck( related.models, 'id' ) );

		return related;
	},

	/**
	 * Normalize and reduce `keyContents` to a list of `ids`, for easier comparison
	 * @param {String|Number|String[]|Number[]|module.Collection} keyContents
	 */
	setKeyContents: function( keyContents ) {
		this.keyContents = keyContents instanceof module.Collection ? keyContents : null;
		this.keyIds = [];

		if ( !this.keyContents && ( keyContents || keyContents === 0 ) ) { // since 0 can be a valid `id` as well
			// Handle cases the an API/user supplies just an Object/id instead of an Array
			this.keyContents = _.isArray( keyContents ) ? keyContents : [ keyContents ];

			_.each( this.keyContents, function( item ) {
				var itemId = module.store.resolveIdForItem( this.relatedModel, item );
				if ( itemId || itemId === 0 ) {
					this.keyIds.push( itemId );
				}
			}, this );
		}
	},

	/**
	 * Event handler for `change:<key>`.
	 * If the contents of the key are changed, notify old & new reverse relations and initialize the new relation.
	 */
	onChange: function( model, attr, options ) {
		options = options ? _.clone( options ) : {};
		this.setKeyContents( attr );
		this.changed = false;

		var related = this.findRelated( options );
		this.setRelated( related );

		if ( !options.silent ) {
			var dit = this;
			module.eventQueue.add( function() {
				// The `changed` flag can be set in `handleAddition` or `handleRemoval`
				if ( dit.changed ) {
					dit.instance.trigger( 'change:' + dit.key, dit.instance, dit.related, options, true );
					dit.changed = false;
				}
			});
		}
	},

	/**
	 * When a model is added to a 'HasMany', trigger 'add' on 'this.instance' and notify reverse relations.
	 * (should be 'HasOne', must set 'this.instance' as their related).
	 */
	handleAddition: function( model, coll, options ) {
		//console.debug('handleAddition called; args=%o', arguments);
		options = options ? _.clone( options ) : {};
		this.changed = true;

		_.each( this.getReverseRelations( model ), function( relation ) {
			relation.addRelated( this.instance, options );
		}, this );

		// Only trigger 'add' once the newly added model is initialized (so, has its relations set up)
		var dit = this;
		!options.silent && module.eventQueue.add( function() {
			dit.instance.trigger( 'add:' + dit.key, model, dit.related, options );
		});
	},

	/**
	 * When a model is removed from a 'HasMany', trigger 'remove' on 'this.instance' and notify reverse relations.
	 * (should be 'HasOne', which should be nullified)
	 */
	handleRemoval: function( model, coll, options ) {
		//console.debug('handleRemoval called; args=%o', arguments);
		options = options ? _.clone( options ) : {};
		this.changed = true;

		_.each( this.getReverseRelations( model ), function( relation ) {
			relation.removeRelated( this.instance, null, options );
		}, this );

		var dit = this;
		!options.silent && module.eventQueue.add( function() {
			dit.instance.trigger( 'remove:' + dit.key, model, dit.related, options );
		});
	},

	handleReset: function( coll, options ) {
		var dit = this;
		options = options ? _.clone( options ) : {};
		!options.silent && module.eventQueue.add( function() {
			dit.instance.trigger( 'reset:' + dit.key, dit.related, options );
		});
	},

	tryAddRelated: function( model, coll, options ) {
		var item = _.contains( this.keyIds, model.id );

		if ( item ) {
			this.addRelated( model, options );
			this.keyIds = _.without( this.keyIds, model.id );
		}
	},

	addRelated: function( model, options ) {
		// Allow 'model' to set up its relations before proceeding.
		// (which can result in a call to 'addRelated' from a relation of 'model')
		var dit = this;
		model.queue( function() {
			if ( dit.related && !dit.related.get( model ) ) {
				dit.related.add( model, _.defaults( { parse: false }, options ) );
			}
		});
	},

	removeRelated: function( model, coll, options ) {
		if ( this.related.get( model ) ) {
			this.related.remove( model, options );
		}
	}
});

/**
 * A type of Backbone.Model that also maintains relations to other models and collections.
 * New events when compared to the original:
 *  - 'add:<key>' (model, related collection, options)
 *  - 'remove:<key>' (model, related collection, options)
 *  - 'change:<key>' (model, related model or collection, options)
 */
module.Model = Backbone.Model.extend( Semaphore ).extend({
	relations: null, // Relation descriptions on the prototype
	_relations: null, // Relation instances
	_isInitialized: false,
	_deferProcessing: false,
	_queue: null,
	_attributeChangeFired: false, // Keeps track of `change` event firing under some conditions (like nested `set`s)

	subModelTypeAttribute: 'type',
	subModelTypes: null,

	constructor: function( attributes, options ) {
		// Nasty hack, for cases like 'model.get( <HasMany key> ).add( item )'.
		// Defer 'processQueue', so that when 'Relation.createModels' is used we trigger 'HasMany'
		// collection events only after the model is really fully set up.
		// Example: event for "p.on( 'add:jobs' )" -> "p.get('jobs').add( { company: c.id, person: p.id } )".
		if ( options && options.collection ) {
			var dit = this,
				collection = this.collection = options.collection;

			// Prevent `collection` from cascading down to nested models; they shouldn't go into this `if` clause.
			delete options.collection;

			this._deferProcessing = true;

			var processQueue = function( model ) {
				if ( model === dit ) {
					dit._deferProcessing = false;
					dit.processQueue();
					collection.off( 'relational:add', processQueue );
				}
			};
			collection.on( 'relational:add', processQueue );

			// So we do process the queue eventually, regardless of whether this model actually gets added to 'options.collection'.
			_.defer( function() {
				processQueue( dit );
			});
		}

		module.store.processOrphanRelations();
		module.store.listenTo( this, 'relational:unregister', module.store.unregister );

		this._queue = new module.BlockingQueue();
		this._queue.block();
		module.eventQueue.block();

		try {
			Backbone.Model.apply( this, arguments );
		}
		finally {
			// Try to run the global queue holding external events
			module.eventQueue.unblock();
		}
	},

	/**
	 * Override 'trigger' to queue 'change' and 'change:*' events
	 */
	trigger: function( eventName ) {
		if ( eventName.length > 5 && eventName.indexOf( 'change' ) === 0 ) {
			var dit = this,
				args = arguments;

			if ( !module.eventQueue.isLocked() ) {
				// If we're not in a more complicated nested scenario, fire the change event right away
				Backbone.Model.prototype.trigger.apply( dit, args );
			}
			else {
				module.eventQueue.add( function() {
					// Determine if the `change` event is still valid, now that all relations are populated
					var changed = true;
					if ( eventName === 'change' ) {
						// `hasChanged` may have gotten reset by nested calls to `set`.
						changed = dit.hasChanged() || dit._attributeChangeFired;
						dit._attributeChangeFired = false;
					}
					else {
						var attr = eventName.slice( 7 ),
							rel = dit.getRelation( attr );

						if ( rel ) {
							// If `attr` is a relation, `change:attr` get triggered from `Relation.onChange`.
							// These take precedence over `change:attr` events triggered by `Model.set`.
							// The relation sets a fourth attribute to `true`. If this attribute is present,
							// continue triggering this event; otherwise, it's from `Model.set` and should be stopped.
							changed = ( args[ 4 ] === true );

							// If this event was triggered by a relation, set the right value in `this.changed`
							// (a Collection or Model instead of raw data).
							if ( changed ) {
								dit.changed[ attr ] = args[ 2 ];
							}
							// Otherwise, this event is from `Model.set`. If the relation doesn't report a change,
							// remove attr from `dit.changed` so `hasChanged` doesn't take it into account.
							else if ( !rel.changed ) {
								delete dit.changed[ attr ];
							}
						}
						else if ( changed ) {
							dit._attributeChangeFired = true;
						}
					}

					changed && Backbone.Model.prototype.trigger.apply( dit, args );
				});
			}
		}
		else if ( eventName === 'destroy' ) {
			Backbone.Model.prototype.trigger.apply( this, arguments );
			module.store.unregister( this );
		}
		else {
			Backbone.Model.prototype.trigger.apply( this, arguments );
		}

		return this;
	},

	/**
	 * Initialize Relations present in this.relations; determine the type (HasOne/HasMany), then creates a new instance.
	 * Invoked in the first call so 'set' (which is made from the Backbone.Model constructor).
	 */
	initializeRelations: function( options ) {
		this.acquire(); // Setting up relations often also involve calls to 'set', and we only want to enter this function once
		this._relations = {};

		_.each( this.relations || [], function( rel ) {
			module.store.initializeRelation( this, rel, options );
		}, this );

		this._isInitialized = true;
		this.release();
		this.processQueue();
	},

	/**
	 * When new values are set, notify this model's relations (also if options.silent is set).
	 * (called from `set`; Relation.setRelated locks this model before calling 'set' on it to prevent loops)
	 * @param {Object} [changedAttrs]
	 * @param {Object} [options]
	 */
	updateRelations: function( changedAttrs, options ) {
		if ( this._isInitialized && !this.isLocked() ) {
			_.each( this._relations, function( rel ) {
				if ( !changedAttrs || ( rel.keySource in changedAttrs || rel.key in changedAttrs ) ) {
					// Fetch data in `rel.keySource` if data got set in there, or `rel.key` otherwise
					var value = this.attributes[ rel.keySource ] || this.attributes[ rel.key ],
						attr = changedAttrs && ( changedAttrs[ rel.keySource ] || changedAttrs[ rel.key ] );

					// Update a relation if its value differs from this model's attributes, or it's been explicitly nullified.
					// Which can also happen before the originally intended related model has been found (`val` is null).
					if ( rel.related !== value || ( value === null && attr === null ) ) {
						this.trigger( 'relational:change:' + rel.key, this, value, options || {} );
					}
				}

				// Explicitly clear 'keySource', to prevent a leaky abstraction if 'keySource' differs from 'key'.
				if ( rel.keySource !== rel.key ) {
					delete this.attributes[ rel.keySource ];
				}
			}, this );
		}
	},

	/**
	 * Either add to the queue (if we're not initialized yet), or execute right away.
	 */
	queue: function( func ) {
		this._queue.add( func );
	},

	/**
	 * Process _queue
	 */
	processQueue: function() {
		if ( this._isInitialized && !this._deferProcessing && this._queue.isBlocked() ) {
			this._queue.unblock();
		}
	},

	/**
	 * Get a specific relation.
	 * @param {string} attr The relation key to look for.
	 * @return {Backbone.Relation} An instance of 'Backbone.Relation', if a relation was found for 'attr', or null.
	 */
	getRelation: function( attr ) {
		return this._relations[ attr ];
	},

	/**
	 * Get all of the created relations.
	 * @return {Backbone.Relation[]}
	 */
	getRelations: function() {
		return _.values( this._relations );
	},


	/**
	 * Get a list of ids that will be fetched on a call to `getAsync`.
	 * @param {string|Backbone.Relation} attr The relation key to fetch models for.
	 * @param [refresh=false] Add ids for models that are already in the relation, refreshing them?
	 * @return {Array} An array of ids that need to be fetched.
	 */
	getIdsToFetch: function( attr, refresh ) {
		var rel = attr instanceof module.Relation ? attr : this.getRelation( attr ),
			ids = rel ? ( rel.keyIds && rel.keyIds.slice( 0 ) ) || ( ( rel.keyId || rel.keyId === 0 ) ? [ rel.keyId ] : [] ) : [];

		// On `refresh`, add the ids for current models in the relation to `idsToFetch`
		if ( refresh ) {
			var models = rel.related && ( rel.related.models || [ rel.related ] );
			_.each( models, function( model ) {
				if ( model.id || model.id === 0 ) {
					ids.push( model.id );
				}
			});
		}

		return ids;
	},

	/**
	 * Get related objects. Returns a single promise, which can either resolve immediately (if the related model[s])
	 * are already present locally, or after fetching the contents of the requested attribute.
	 * @param {string} attr The relation key to fetch models for.
	 * @param {Object} [options] Options for 'Backbone.Model.fetch' and 'Backbone.sync'.
	 * @param {Boolean} [options.refresh=false] Fetch existing models from the server as well (in order to update them).
	 * @return {jQuery.Deferred} A jQuery promise object. When resolved, its `done` callback will be called with
	 *  contents of `attr`.
	 */
	getAsync: function( attr, options ) {
		// Set default `options` for fetch
		options = _.extend( { add: true, remove: false, refresh: false }, options );

		var dit = this,
			requests = [],
			rel = this.getRelation( attr ),
			idsToFetch = rel && this.getIdsToFetch( rel, options.refresh ),
			coll = rel.related instanceof module.Collection ? rel.related : rel.relatedCollection;

		if ( idsToFetch && idsToFetch.length ) {
			var models = [],
				createdModels = [],
				setUrl,
				createModels = function() {
					// Find (or create) a model for each one that is to be fetched
					models = _.map( idsToFetch, function( id ) {
						var model = rel.relatedModel.findModel( id );

						if ( !model ) {
							var attrs = {};
							attrs[ rel.relatedModel.prototype.idAttribute ] = id;
							model = rel.relatedModel.findOrCreate( attrs, options );
							createdModels.push( model );
						}

						return model;
					}, this );
				};

			// Try if the 'collection' can provide a url to fetch a set of models in one request.
			// This assumes that when 'module.Collection.url' is a function, it can handle building of set urls.
			// To make sure it can, test if the url we got by supplying a list of models to fetch is different from
			// the one supplied for the default fetch action (without args to 'url').
			if ( coll instanceof module.Collection && _.isFunction( coll.url ) ) {
				var defaultUrl = coll.url();
				setUrl = coll.url( idsToFetch );

				if ( setUrl === defaultUrl ) {
					createModels();
					setUrl = coll.url( models );

					if ( setUrl === defaultUrl ) {
						setUrl = null;
					}
				}
			}

			if ( setUrl ) {
				// Do a single request to fetch all models
				var opts = _.defaults(
					{
						error: function() {
							_.each( createdModels, function( model ) {
								model.trigger( 'destroy', model, model.collection, options );
							});

							options.error && options.error.apply( models, arguments );
						},
						url: setUrl
					},
					options
				);

				requests = [ coll.fetch( opts ) ];
			}
			else {
				// Make a request per model to fetch
				if  ( !models.length ) {
					createModels();
				}

				requests = _.map( models, function( model ) {
					var opts = _.defaults(
						{
							error: function() {
								if ( _.contains( createdModels, model ) ) {
									model.trigger( 'destroy', model, model.collection, options );
								}
								options.error && options.error.apply( models, arguments );
							}
						},
						options
					);
					return model.fetch( opts );
				}, this );
			}
		}

		return this.deferArray(requests).then(
			function() {
				return Backbone.Model.prototype.get.call( dit, attr );
			}
		);
	},

	deferArray: function(deferArray) {
		return Backbone.$.when.apply(null, deferArray);
	},

	set: function( key, value, options ) {
		module.eventQueue.block();

		// Duplicate backbone's behavior to allow separate key/value parameters, instead of a single 'attributes' object
		var attributes,
			result;

		if ( _.isObject( key ) || key == null ) {
			attributes = key;
			options = value;
		}
		else {
			attributes = {};
			attributes[ key ] = value;
		}

		try {
			var id = this.id,
				newId = attributes && this.idAttribute in attributes && attributes[ this.idAttribute ];

			// Check if we're not setting a duplicate id before actually calling `set`.
			module.store.checkId( this, newId );

			result = Backbone.Model.prototype.set.apply( this, arguments );

			// Ideal place to set up relations, if this is the first time we're here for this model
			if ( !this._isInitialized && !this.isLocked() ) {
				this.constructor.initializeModelHierarchy();

				// Only register models that have an id. A model will be registered when/if it gets an id later on.
				if ( newId || newId === 0 ) {
					module.store.register( this );
				}

				this.initializeRelations( options );
			}
			// The store should know about an `id` update asap
			else if ( newId && newId !== id ) {
				module.store.update( this );
			}

			if ( attributes ) {
				this.updateRelations( attributes, options );
			}
		}
		finally {
			// Try to run the global queue holding external events
			module.eventQueue.unblock();
		}

		return result;
	},

	clone: function() {
		var attributes = _.clone( this.attributes );
		if ( !_.isUndefined( attributes[ this.idAttribute ] ) ) {
			attributes[ this.idAttribute ] = null;
		}

		_.each( this.getRelations(), function( rel ) {
			delete attributes[ rel.key ];
		});

		return new this.constructor( attributes );
	},

	/**
	 * Convert relations to JSON, omits them when required
	 */
	toJSON: function( options ) {
		// If this Model has already been fully serialized in this branch once, return to avoid loops
		if ( this.isLocked() ) {
			return this.id;
		}

		this.acquire();
		var json = Backbone.Model.prototype.toJSON.call( this, options );

		if ( this.constructor._superModel && !( this.constructor._subModelTypeAttribute in json ) ) {
			json[ this.constructor._subModelTypeAttribute ] = this.constructor._subModelTypeValue;
		}

		_.each( this._relations, function( rel ) {
			var related = json[ rel.key ],
				includeInJSON = rel.options.includeInJSON,
				value = null;

			if ( includeInJSON === true ) {
				if ( related && _.isFunction( related.toJSON ) ) {
					value = related.toJSON( options );
				}
			}
			else if ( _.isString( includeInJSON ) ) {
				if ( related instanceof module.Collection ) {
					value = related.pluck( includeInJSON );
				}
				else if ( related instanceof Backbone.Model ) {
					value = related.get( includeInJSON );
				}

				// Add ids for 'unfound' models if includeInJSON is equal to (only) the relatedModel's `idAttribute`
				if ( includeInJSON === rel.relatedModel.prototype.idAttribute ) {
					if ( rel instanceof module.HasMany ) {
						value = value.concat( rel.keyIds );
					}
					else if ( rel instanceof module.HasOne ) {
						value = value || rel.keyId;

						if ( !value && !_.isObject( rel.keyContents ) ) {
							value = rel.keyContents || null;
						}
					}
				}
			}
			else if ( _.isArray( includeInJSON ) ) {
				if ( related instanceof module.Collection ) {
					value = [];
					related.each( function( model ) {
						var curJson = {};
						_.each( includeInJSON, function( key ) {
							curJson[ key ] = model.get( key );
						});
						value.push( curJson );
					});
				}
				else if ( related instanceof Backbone.Model ) {
					value = {};
					_.each( includeInJSON, function( key ) {
						value[ key ] = related.get( key );
					});
				}
			}
			else {
				delete json[ rel.key ];
			}

			// In case of `wait: true`, Backbone will simply push whatever's passed into `save` into attributes.
			// We'll want to get this information into the JSON, even if it doesn't conform to our normal
			// expectations of what's contained in it (no model/collection for a relation, etc).
			if ( value === null && options && options.wait ) {
				value = related;
			}

			if ( includeInJSON ) {
				json[ rel.keyDestination ] = value;
			}

			if ( rel.keyDestination !== rel.key ) {
				delete json[ rel.key ];
			}
		});

		this.release();
		return json;
	}
},
{
	/**
	 *
	 * @param superModel
	 * @returns {Backbone.Relational.Model.constructor}
	 */
	setup: function( superModel ) {
		// We don't want to share a relations array with a parent, as this will cause problems with reverse
		// relations. Since `relations` may also be a property or function, only use slice if we have an array.
		this.prototype.relations = ( this.prototype.relations || [] ).slice( 0 );

		this._subModels = {};
		this._superModel = null;

		// If this model has 'subModelTypes' itself, remember them in the store
		if ( this.prototype.hasOwnProperty( 'subModelTypes' ) ) {
			module.store.addSubModels( this.prototype.subModelTypes, this );
		}
		// The 'subModelTypes' property should not be inherited, so reset it.
		else {
			this.prototype.subModelTypes = null;
		}

		// Initialize all reverseRelations that belong to this new model.
		_.each( this.prototype.relations || [], function( rel ) {
			if ( !rel.model ) {
				rel.model = this;
			}

			if ( rel.reverseRelation && rel.model === this ) {
				var preInitialize = true;
				if ( _.isString( rel.relatedModel ) ) {
					/**
					 * The related model might not be defined for two reasons
					 *  1. it is related to itself
					 *  2. it never gets defined, e.g. a typo
					 *  3. the model hasn't been defined yet, but will be later
					 * In neither of these cases do we need to pre-initialize reverse relations.
					 * However, for 3. (which is, to us, indistinguishable from 2.), we do need to attempt
					 * setting up this relation again later, in case the related model is defined later.
					 */
					var relatedModel = module.store.getObjectByName( rel.relatedModel );
					preInitialize = relatedModel && ( relatedModel.prototype instanceof module.Model );
				}

				if ( preInitialize ) {
					module.store.initializeRelation( null, rel );
				}
				else if ( _.isString( rel.relatedModel ) ) {
					module.store.addOrphanRelation( rel );
				}
			}
		}, this );

		return this;
	},

	/**
	 * Create a 'Backbone.Model' instance based on 'attributes'.
	 * @param {Object} attributes
	 * @param {Object} [options]
	 * @return {Backbone.Model}
	 */
	build: function( attributes, options ) {
		// 'build' is a possible entrypoint; it's possible no model hierarchy has been determined yet.
		this.initializeModelHierarchy();

		// Determine what type of (sub)model should be built if applicable.
		var model = this._findSubModelType( this, attributes ) || this;

		return new model( attributes, options );
	},

	/**
	 * Determines what type of (sub)model should be built if applicable.
	 * Looks up the proper subModelType in 'this._subModels', recursing into
	 * types until a match is found.  Returns the applicable 'Backbone.Model'
	 * or null if no match is found.
	 * @param {Backbone.Model} type
	 * @param {Object} attributes
	 * @return {Backbone.Model}
	 */
	_findSubModelType: function( type, attributes ) {
		if ( type._subModels && type.prototype.subModelTypeAttribute in attributes ) {
			var subModelTypeAttribute = attributes[ type.prototype.subModelTypeAttribute ];
			var subModelType = type._subModels[ subModelTypeAttribute ];
			if ( subModelType ) {
				return subModelType;
			}
			else {
				// Recurse into subModelTypes to find a match
				for ( subModelTypeAttribute in type._subModels ) {
					subModelType = this._findSubModelType( type._subModels[ subModelTypeAttribute ], attributes );
					if ( subModelType ) {
						return subModelType;
					}
				}
			}
		}
		return null;
	},

	/**
	 *
	 */
	initializeModelHierarchy: function() {
		// Inherit any relations that have been defined in the parent model.
		this.inheritRelations();

		// If we came here through 'build' for a model that has 'subModelTypes' then try to initialize the ones that
		// haven't been resolved yet.
		if ( this.prototype.subModelTypes ) {
			var resolvedSubModels = _.keys( this._subModels );
			var unresolvedSubModels = _.omit( this.prototype.subModelTypes, resolvedSubModels );
			_.each( unresolvedSubModels, function( subModelTypeName ) {
				var subModelType = module.store.getObjectByName( subModelTypeName );
				subModelType && subModelType.initializeModelHierarchy();
			});
		}
	},

	inheritRelations: function() {
		// Bail out if we've been here before.
		if ( !_.isUndefined( this._superModel ) && !_.isNull( this._superModel ) ) {
			return;
		}
		// Try to initialize the _superModel.
		module.store.setupSuperModel( this );

		// If a superModel has been found, copy relations from the _superModel if they haven't been inherited automatically
		// (due to a redefinition of 'relations').
		if ( this._superModel ) {
			// The _superModel needs a chance to initialize its own inherited relations before we attempt to inherit relations
			// from the _superModel. You don't want to call 'initializeModelHierarchy' because that could cause sub-models of
			// this class to inherit their relations before this class has had chance to inherit it's relations.
			this._superModel.inheritRelations();
			if ( this._superModel.prototype.relations ) {
				// Find relations that exist on the '_superModel', but not yet on this model.
				var inheritedRelations = _.filter( this._superModel.prototype.relations || [], function( superRel ) {
					return !_.any( this.prototype.relations || [], function( rel ) {
						return superRel.relatedModel === rel.relatedModel && superRel.key === rel.key;
					}, this );
				}, this );

				this.prototype.relations = inheritedRelations.concat( this.prototype.relations );
			}
		}
		// Otherwise, make sure we don't get here again for this type by making '_superModel' false so we fail the
		// isUndefined/isNull check next time.
		else {
			this._superModel = false;
		}
	},

	/**
	 * Find an instance of `this` type in 'Backbone.store'.
	 * A new model is created if no matching model is found, `attributes` is an object, and `options.create` is true.
	 * - If `attributes` is a string or a number, `findOrCreate` will query the `store` and return a model if found.
	 * - If `attributes` is an object and is found in the store, the model will be updated with `attributes` unless `options.merge` is `false`.
	 * @param {Object|String|Number} attributes Either a model's id, or the attributes used to create or update a model.
	 * @param {Object} [options]
	 * @param {Boolean} [options.create=true]
	 * @param {Boolean} [options.merge=true]
	 * @param {Boolean} [options.parse=false]
	 * @return {Backbone.Relational.Model}
	 */
	findOrCreate: function( attributes, options ) {
		options || ( options = {} );
		var parsedAttributes = ( _.isObject( attributes ) && options.parse && this.prototype.parse ) ?
			this.prototype.parse( _.clone( attributes ), options ) : attributes;

		// If specified, use a custom `find` function to match up existing models to the given attributes.
		// Otherwise, try to find an instance of 'this' model type in the store
		var model = this.findModel( parsedAttributes );

		// If we found an instance, update it with the data in 'item' (unless 'options.merge' is false).
		// If not, create an instance (unless 'options.create' is false).
		if ( _.isObject( attributes ) ) {
			if ( model && options.merge !== false ) {
				// Make sure `options.collection` and `options.url` doesn't cascade to nested models
				delete options.collection;
				delete options.url;

				model.set( parsedAttributes, options );
			}
			else if ( !model && options.create !== false ) {
				model = this.build( parsedAttributes, _.defaults( { parse: false }, options ) );
			}
		}

		return model;
	},

	/**
	 * Find an instance of `this` type in 'Backbone.store'.
	 * - If `attributes` is a string or a number, `find` will query the `store` and return a model if found.
	 * - If `attributes` is an object and is found in the store, the model will be updated with `attributes` unless `options.merge` is `false`.
	 * @param {Object|String|Number} attributes Either a model's id, or the attributes used to create or update a model.
	 * @param {Object} [options]
	 * @param {Boolean} [options.merge=true]
	 * @param {Boolean} [options.parse=false]
	 * @return {Backbone.Relational.Model}
	 */
	find: function( attributes, options ) {
		options || ( options = {} );
		options.create = false;
		return this.findOrCreate( attributes, options );
	},

	/**
	 * A hook to override the matching when updating (or creating) a model.
	 * The default implementation is to look up the model by id in the store.
	 * @param {Object} attributes
	 * @returns {Backbone.Relational.Model}
	 */
	findModel: function( attributes ) {
		return module.store.find( this, attributes );
	},
	// Override .extend() to automatically call .setup()
	extend: function( protoProps, classProps ) {
		var child = BBModel.extend.apply( this, arguments );

		child.setup( this );

		return child;
	}
});

relationTypeStore.registerType( 'HasOne', module.HasOne );
relationTypeStore.registerType( 'HasMany', module.HasMany );

export default module;
