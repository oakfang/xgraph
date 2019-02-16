const fs = require('fs');
const uuid = require('uuid');
const Graph = require('@xgraph/core');
const q = require('@xgraph/q');
const tx = require('@xgraph/tx');

module.exports = class XGraph {
  constructor(dataPath) {
    this._fsLock = false;
    this.__graph = null;
    this._dataPath = dataPath;
    if (this._dataPath && fs.existsSync(this._dataPath)) {
      const data = JSON.parse(
        fs.readFileSync(this._dataPath, { encoding: 'utf8' })
      );
      this._graph = Graph.fromObject(data);
    } else {
      this._graph = new Graph();
    }
  }

  withTx(cb) {
    if (this.__graph) {
      return cb();
    }
    this.__graph = this._graph;
    tx(
      this._graph,
      ({ graph }) => {
        this._graph = graph;
        cb();
      },
      {
        onCommit: () => {
          this._graph = this.__graph;
          this.__graph = null;
          if (this._dataPath) {
            this._fsLock = (this._fsLock || Promise.resolve()).then(
              () =>
                new Promise(resolve => {
                  const obj = this._graph.toObject();
                  const data = JSON.stringify(obj);
                  fs.writeFile(this._dataPath, data, resolve);
                })
            );
          }
        },
        onRollback: () => {
          this._graph = this.__graph;
          this.__graph = null;
        },
      }
    );
  }

  _getEdgesProxy(vid) {
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
    let sets = {};
    const flush = () => {
      this.withTx(() => {
        this._graph.setVertex(v.id, v.type, { ...v, ...sets });
        v = this._graph.vertex(v.id);
      });
      sets = {};
    };
    return new Proxy(
      {},
      {
        get: (_, prop) => {
          if (prop === 'flush') {
            return flush;
          }
          if (prop === '$') {
            return this._getEdgesProxy(v.id);
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
  }

  _wrapVertex(id, edgeProps) {
    return this._wrapVertexInstance(this._graph.vertex(id), edgeProps);
  }

  createModelType(type) {
    const create = props => {
      const id = uuid();
      this.withTx(() => {
        this._graph.setVertex(id, type, props);
      });
      return this._wrapVertex(id);
    };
    create.findById = id => {
      if (this._graph.hasVertex(id)) {
        return this._wrapVertex(id);
      }
    };
    return create;
  }

  query(queryFragments, ...values) {
    const results = Array.isArray(queryFragments)
      ? q(this._graph)(queryFragments, ...values)
      : q(this._graph, queryFragments);
    const wrap = this._wrapVertexInstance.bind(this);
    return Object.keys(results).reduce((final, vName) => {
      final[vName] = results[vName].map(result =>
        result.id
          ? wrap(result)
          : {
              ...result,
              get origin() {
                return wrap(result.origin, result.properties);
              },
              get target() {
                return wrap(result.target, result.properties);
              },
            }
      );
      return final;
    }, {});
  }
};
