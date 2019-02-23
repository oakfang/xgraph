const BaseGraph = require('./lib/base');

function getBoundObject(ctx, proto) {
  return Reflect.ownKeys(proto).reduce((bound, prop) => {
    const desc = Reflect.getOwnPropertyDescriptor(proto, prop);
    ['get', 'set', 'value'].forEach(dProp => {
      if (typeof desc[dProp] === 'function') {
        desc[dProp] = desc[dProp].bind(ctx);
      }
    });
    Object.defineProperty(bound, prop, desc);
    return bound;
  }, {});
}

module.exports = class XGraph extends BaseGraph {
  _getSingleEdgesProxy(vid) {
    return new Proxy(
      {},
      {
        get: (_, type) => {
          const [edge] = this._graph
            .outEdges(vid)
            .filter(e => e.type === type)
            .limit(1);
          if (!edge) {
            return null;
          }
          const { target, properties } = edge;
          return this._wrapVertexInstance(target, properties);
        },
        set: (_, type, target) => {
          const { $backtrace, id: tid } = target;
          this.withTx(() => {
            this._graph.setEdge(vid, tid, type, $backtrace);
          });
          return true;
        },
        deleteProperty: (_, type) => {
          this.withTx(() => {
            const [edge] = this._graph
              .outEdges(vid)
              .filter(e => e.type === type)
              .limit(1);
            if (!edge) {
              return null;
            }
            this._graph.removeEdge(edge.origin.id, edge.target.id, type);
          });
        },
      }
    );
  }

  _getMultiEdgesProxy(vid) {
    return new Proxy(
      {},
      {
        get: (_, type) => ({
          get: () =>
            this._graph
              .outEdges(vid)
              .filter(e => e.type === type)
              .map(({ target, properties }) =>
                this._wrapVertexInstance(target, properties)
              ),
          add: (target, properties, mutual = false) => {
            this.withTx(() => {
              this._graph.setEdge(vid, target.id, type, properties);
              if (mutual) {
                this._graph.setEdge(target.id, vid, type, properties);
              }
            });
          },
          has: target => {
            return this._graph.hasEdge(vid, target.id, type);
          },
          remove: (target, mutual = false) => {
            this.withTx(() => {
              this._graph.removeEdge(vid, target.id, type);
              if (mutual) {
                this._graph.removeEdge(target.id, vid, type);
              }
            });
          },
        }),
      }
    );
  }

  _wrapVertexInstance(v, edgeProps) {
    const proto = this._protos[v.type];
    let sets = {};
    const flush = () => {
      this.withTx(() => {
        this._graph.setVertex(v.id, v.type, { ...v, ...sets });
        v = this._graph.vertex(v.id);
      });
      sets = {};
    };
    let bound;
    const instance = new Proxy(
      {},
      {
        get: (_, prop) => {
          if (bound && prop in bound) {
            return bound[prop];
          }
          if (prop === 'flush') {
            return flush;
          }
          if (prop === '$') {
            return this._getMultiEdgesProxy(v.id);
          }
          if (prop === '_') {
            return this._getSingleEdgesProxy(v.id);
          }
          if (prop === '$backtrace') {
            return edgeProps;
          }
          return prop in sets ? sets[prop] : this._graph.vertex(v.id)[prop];
        },
        set: (_, prop, value) => {
          sets[prop] = value;
          if (Object.keys(sets).length === 1) {
            setImmediate(() => {
              if (Object.keys(sets).length) {
                flush();
              }
            });
          }
          return true;
        },
      }
    );
    if (proto) {
      bound = getBoundObject(instance, proto);
    }
    return instance;
  }
};
