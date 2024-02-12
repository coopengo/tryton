CREATE SEQUENCE ir_configuration_id_seq;

CREATE TABLE ir_configuration (
    id INTEGER DEFAULT NEXTVAL('ir_configuration_id_seq') NOT NULL
        CONSTRAINT ir_configuration_id_positive CHECK(id >= 0),
    language VARCHAR,
    hostname VARCHAR,
    PRIMARY KEY(id)
);

CREATE SEQUENCE ir_model_id_seq;

CREATE TABLE ir_model (
    id INTEGER DEFAULT NEXTVAL('ir_model_id_seq') NOT NULL
        CONSTRAINT ir_model_id_positive CHECK(id >= 0),
    model VARCHAR NOT NULL,
    name VARCHAR,
    info TEXT,
    module VARCHAR,
    PRIMARY KEY(id)
);

CREATE SEQUENCE ir_model_field_id_seq;

CREATE TABLE ir_model_field (
    id INTEGER DEFAULT NEXTVAL('ir_model_field_id_seq') NOT NULL
        CONSTRAINT ir_model_field_id_positive CHECK(id >= 0),
    model INTEGER,
    name VARCHAR NOT NULL,
    relation VARCHAR,
    field_description VARCHAR,
    ttype VARCHAR,
    help TEXT,
    module VARCHAR,
    "access" BOOL,
    PRIMARY KEY(id),
    FOREIGN KEY (model) REFERENCES ir_model(id) ON DELETE CASCADE
);

CREATE SEQUENCE ir_ui_view_id_seq;

CREATE TABLE ir_ui_view (
    id INTEGER DEFAULT NEXTVAL('ir_ui_view_id_seq') NOT NULL
        CONSTRAINT ir_ui_view_id_positive CHECK(id >= 0),
    model VARCHAR NOT NULL,
    "type" VARCHAR,
    data TEXT NOT NULL,
    field_childs VARCHAR,
    priority INTEGER NOT NULL,
    PRIMARY KEY(id)
);

CREATE SEQUENCE ir_ui_menu_id_seq;

CREATE TABLE ir_ui_menu (
    id INTEGER DEFAULT NEXTVAL('ir_ui_menu_id_seq') NOT NULL
        CONSTRAINT ir_ui_menu_id_positive CHECK(id >= 0),
    parent INTEGER,
    name VARCHAR NOT NULL,
    icon VARCHAR,
    PRIMARY KEY (id),
    FOREIGN KEY (parent) REFERENCES ir_ui_menu (id) ON DELETE SET NULL
);

CREATE SEQUENCE ir_translation_id_seq;

CREATE TABLE ir_translation (
    id INTEGER DEFAULT NEXTVAL('ir_translation_id_seq') NOT NULL
        CONSTRAINT ir_translation_id_positive CHECK(id >= 0),
    lang VARCHAR,
    src TEXT,
    name VARCHAR NOT NULL,
    res_id INTEGER,
    value TEXT,
    "type" VARCHAR,
    module VARCHAR,
    fuzzy BOOLEAN NOT NULL,
    PRIMARY KEY(id)
);

CREATE SEQUENCE ir_lang_id_seq;

CREATE TABLE ir_lang (
    id INTEGER DEFAULT NEXTVAL('ir_lang_id_seq') NOT NULL
        CONSTRAINT ir_lang_id_positive CHECK(id >= 0),
    name VARCHAR NOT NULL,
    code VARCHAR NOT NULL,
    translatable BOOLEAN NOT NULL,
    parent VARCHAR,
    active BOOLEAN NOT NULL,
    direction VARCHAR NOT NULL,
    PRIMARY KEY(id)
);

CREATE SEQUENCE res_user_id_seq;

CREATE TABLE res_user (
    id INTEGER DEFAULT NEXTVAL('res_user_id_seq') NOT NULL
        CONSTRAINT res_user_id_positive CHECK(id >= 0),
    name VARCHAR NOT NULL,
    active BOOLEAN NOT NULL,
    login VARCHAR NOT NULL,
    password VARCHAR,
    PRIMARY KEY(id)
);

ALTER TABLE res_user ADD CONSTRAINT res_user_login_key UNIQUE (login);

INSERT INTO res_user (id, login, password, name, active) VALUES (0, 'root', NULL, 'Root', False);

CREATE SEQUENCE res_group_id_seq;

CREATE TABLE res_group (
    id INTEGER DEFAULT NEXTVAL('res_group_id_seq') NOT NULL
        CONSTRAINT res_group_id_positive CHECK(id >= 0),
    name VARCHAR NOT NULL,
    PRIMARY KEY(id)
);

CREATE SEQUENCE "res_user-res_group_id_seq";

CREATE TABLE "res_user-res_group" (
    id INTEGER DEFAULT NEXTVAL('res_user-res_group_id_seq') NOT NULL
        CONSTRAINT "res_user-res_group_id_positive" CHECK(id >= 0),
    "user" INTEGER NOT NULL,
    "group" INTEGER NOT NULL,
    FOREIGN KEY ("user") REFERENCES res_user (id) ON DELETE CASCADE,
    FOREIGN KEY ("group") REFERENCES res_group (id) ON DELETE CASCADE,
    PRIMARY KEY(id)
);

CREATE SEQUENCE ir_module_id_seq;

CREATE TABLE ir_module (
    id INTEGER DEFAULT NEXTVAL('ir_module_id_seq') NOT NULL
        CONSTRAINT ir_module_id_positive CHECK(id >= 0),
    create_uid INTEGER NOT NULL,
    create_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    write_date TIMESTAMP WITHOUT TIME ZONE,
    write_uid INTEGER,
    name VARCHAR NOT NULL,
    state VARCHAR,
    PRIMARY KEY(id),
    FOREIGN KEY (create_uid) REFERENCES res_user ON DELETE SET NULL,
    FOREIGN KEY (write_uid) REFERENCES res_user ON DELETE SET NULL
);

ALTER TABLE ir_module ADD CONSTRAINT ir_module_name_uniq UNIQUE (name);

CREATE SEQUENCE ir_module_dependency_id_seq;

CREATE TABLE ir_module_dependency (
    id INTEGER DEFAULT NEXTVAL('ir_module_dependency_id_seq') NOT NULL
        CONSTRAINT ir_module_dependency_id_positive CHECK(id >= 0),
    create_uid INTEGER NOT NULL,
    create_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    write_date TIMESTAMP WITHOUT TIME ZONE,
    write_uid INTEGER,
    name VARCHAR,
    module INTEGER,
    PRIMARY KEY(id),
    FOREIGN KEY (create_uid) REFERENCES res_user ON DELETE SET NULL,
    FOREIGN KEY (write_uid) REFERENCES res_user ON DELETE SET NULL,
    FOREIGN KEY (module) REFERENCES ir_module ON DELETE CASCADE
);

CREATE SEQUENCE ir_cache_id_seq;

CREATE TABLE ir_cache (
    id INTEGER DEFAULT NEXTVAL('ir_cache_id_seq') NOT NULL,
        CONSTRAINT ir_cache_id_positive CHECK(id >= 0),
    name VARCHAR NOT NULL,
    "timestamp" TIMESTAMP WITHOUT TIME ZONE,
    create_date TIMESTAMP WITHOUT TIME ZONE,
    create_uid INTEGER,
    write_date TIMESTAMP WITHOUT TIME ZONE,
    write_uid INTEGER
);
